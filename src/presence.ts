/*
 * Which widgets are open in the room, and which of them can answer.
 *
 * Every widget instance announces itself with a small timeline event: when it
 * opens, when its model or "answer everyone" setting changes, every few minutes
 * while open, and once more ("offline") when the page goes away. A newly opened
 * widget sends a probe; the others answer it with an announcement, so the count
 * is right within seconds instead of after a heartbeat. Timeline rather than room
 * state: ordinary members may not send state in most rooms, and timeline events
 * are encrypted in an E2EE room. Clients do not render the unknown event type.
 *
 * The announcement also carries what this device has donated to the room so far:
 * answers posted, tokens processed and generated, and GPU time. Totals are kept
 * per device, so a user's donation is the sum over their devices.
 *
 * Pure: no widget API here; the controller sends and feeds events.
 */
import type { IRoomEvent } from "matrix-widget-api";

export const PRESENCE_TYPE = "de.datanauten.llm_widget.presence";
/**
 * How often an open widget repeats its announcement. Rare on purpose: every
 * announcement is a timeline event, and hosts read back only the last ~50.
 */
export const HEARTBEAT_MS = 10 * 60_000;
/** An announcement older than this no longer counts: the page closed without saying so. */
export const PRESENCE_TTL_MS = 2 * HEARTBEAT_MS + 60_000;

/** Work one device did for the room: answers it posted there. */
export interface Donation {
    answers: number;
    /** Prompt tokens read (prefill), including the acknowledgement rounds. */
    promptTokens: number;
    /** Tokens generated. */
    completionTokens: number;
    /** Time the model spent on these answers, in milliseconds. */
    gpuMs: number;
}

export const NO_DONATION: Donation = { answers: 0, promptTokens: 0, completionTokens: 0, gpuMs: 0 };

export function addDonation(a: Donation, b: Donation): Donation {
    return {
        answers: a.answers + b.answers,
        promptTokens: a.promptTokens + b.promptTokens,
        completionTokens: a.completionTokens + b.completionTokens,
        gpuMs: a.gpuMs + b.gpuMs,
    };
}

export interface PresenceContent {
    /** Random per page load: one user can have the widget open on several devices. */
    instance: string;
    /** Random per browser, kept: totals are per device and must not be counted twice. */
    device: string;
    online: boolean;
    /** The loaded model, or null while none is loaded. */
    model: string | null;
    /** True when it answers every member's requests, not only its owner's. */
    everyone: boolean;
    prefix: string;
    /** Asks the other open widgets to announce themselves now. */
    probe?: boolean;
    donated: Donation;
}

export interface Peer extends PresenceContent {
    sender: string;
    ts: number;
}

export function presenceContent(c: PresenceContent): Record<string, unknown> {
    return { ...c };
}

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

function toDonation(v: unknown): Donation {
    const d = (v ?? {}) as Partial<Record<keyof Donation, unknown>>;
    return {
        answers: count(d.answers),
        promptTokens: count(d.promptTokens),
        completionTokens: count(d.completionTokens),
        gpuMs: count(d.gpuMs),
    };
}

export function toPresence(ev: IRoomEvent): Peer | null {
    if (ev.type !== PRESENCE_TYPE) return null;
    const c = (ev.content ?? {}) as Partial<PresenceContent>;
    if (typeof c.instance !== "string" || !c.instance) return null;
    return {
        instance: c.instance,
        device: typeof c.device === "string" && c.device ? c.device : c.instance,
        donated: toDonation(c.donated),
        online: c.online !== false,
        model: typeof c.model === "string" && c.model ? c.model : null,
        everyone: c.everyone === true,
        prefix: typeof c.prefix === "string" ? c.prefix : "",
        probe: c.probe === true,
        sender: ev.sender,
        ts: ev.origin_server_ts ?? 0,
    };
}

export interface Summary {
    /** Widgets open in the room, this one included. */
    open: number;
    /** Of those, with a model loaded. */
    ready: number;
    /** Ready and answering everyone's requests. */
    forEveryone: number;
    /** Ready to answer a request from `userId`: theirs, or one answering everyone. */
    forUser: number;
    peers: Peer[];
}

export interface Donor {
    user: string;
    donated: Donation;
}

export class Roster {
    private byInstance = new Map<string, Peer>();
    /** Newest totals per user and device; kept after the widget closes. */
    private byDevice = new Map<string, Peer>();

    /** Keeps the newest announcement per instance. Returns it, or null if it was not newer. */
    add(p: Peer): Peer | null {
        const key = `${p.sender}|${p.device}`;
        const dev = this.byDevice.get(key);
        if (!dev || dev.ts <= p.ts) this.byDevice.set(key, p);
        const old = this.byInstance.get(p.instance);
        if (old && old.ts > p.ts) return null;
        this.byInstance.set(p.instance, p);
        return p;
    }

    /**
     * Everyone who has donated, most GPU time first. Only as complete as the
     * announcements this widget has seen: live ones, plus what the host returns
     * from recent history.
     */
    donors(): Donor[] {
        const byUser = new Map<string, Donation>();
        for (const p of this.byDevice.values()) byUser.set(p.sender, addDonation(byUser.get(p.sender) ?? NO_DONATION, p.donated));
        return [...byUser]
            .map(([user, donated]) => ({ user, donated }))
            .filter((d) => d.donated.answers > 0)
            .sort((a, b) => b.donated.gpuMs - a.donated.gpuMs || a.user.localeCompare(b.user));
    }

    /** Live instances, own first, then by user. */
    summary(now: number, userId: string | null, self: string): Summary {
        const peers = [...this.byInstance.values()]
            .filter((p) => p.online && now - p.ts < PRESENCE_TTL_MS)
            .sort((a, b) => Number(b.instance === self) - Number(a.instance === self) || a.sender.localeCompare(b.sender));
        const ready = peers.filter((p) => p.model);
        return {
            open: peers.length,
            ready: ready.length,
            forEveryone: ready.filter((p) => p.everyone).length,
            forUser: ready.filter((p) => p.everyone || p.sender === userId).length,
            peers,
        };
    }
}
