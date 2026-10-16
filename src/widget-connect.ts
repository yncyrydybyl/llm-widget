/*
 * Widget bootstrap over plain matrix-widget-api, written for hosts that enforce
 * consent (Marcade Player strict mode) and for Element Web/Desktop.
 *
 * Adapted from the matrix-widget skill template. Everything here exists because
 * of a specific host behaviour; the comments say which.
 */
import {
    EventDirection,
    MatrixCapabilities,
    WidgetEventCapability,
    WidgetApi,
    WidgetApiToWidgetAction,
    type Capability,
    type IRoomEvent,
    type IWidgetApiRequest,
} from "matrix-widget-api";
import { PRESENCE_TYPE } from "./presence";

/** Parameters may arrive in the query (host-appended) or the fragment (ours). */
export interface Params {
    get(name: string): string | null;
}

export function readParams(search = window.location.search, hash = window.location.hash): Params {
    const query = new URLSearchParams(search);
    const q = hash.indexOf("?");
    const fragment = new URLSearchParams(q === -1 ? "" : hash.slice(q));
    // Fragment wins: it is where we put our own config, and it never reaches the
    // server hosting the widget. Reading only one source masks the other and the
    // handshake hangs (no parentUrl ⇒ untargeted postMessage).
    return { get: (name) => fragment.get(name) ?? query.get(name) };
}

export const CAPABILITIES: Capability[] = [
    // Useless outside a client: it has no session of its own. Auto-granted by
    // Element and the Player; hides Element's "pop out" button.
    MatrixCapabilities.RequiresClient,
    // Read the conversation the model works with: plain text, plus notices so
    // earlier model answers stay in context. One msgtype per capability.
    WidgetEventCapability.forRoomMessageEvent(EventDirection.Receive, "m.text").raw as Capability,
    WidgetEventCapability.forRoomMessageEvent(EventDirection.Receive, "m.notice").raw as Capability,
    // Post answers. Notices, not text: clients render them as machine output and
    // bots conventionally never react to them, so two widgets cannot loop.
    WidgetEventCapability.forRoomMessageEvent(EventDirection.Send, "m.notice").raw as Capability,
    // Presence: which widgets are open, which can answer, and what each device
    // has donated. A custom timeline event type that clients do not render.
    WidgetEventCapability.forRoomEvent(EventDirection.Send, PRESENCE_TYPE).raw as Capability,
    WidgetEventCapability.forRoomEvent(EventDirection.Receive, PRESENCE_TYPE).raw as Capability,
];

export interface Connection {
    api: WidgetApi;
    /** Capabilities the host actually approved (empty until `ready`). */
    approved: Capability[];
}

/**
 * Returns null when the page is not framed by a client: run standalone or in a
 * demo mode then. Otherwise resolves once the host has answered the capability
 * request — or after `timeoutMs`, because some hosts never negotiate.
 */
export async function connect(
    params: Params,
    handlers: {
        onState?: (events: IRoomEvent[]) => void;
        onEvent?: (event: IRoomEvent) => void;
        onTheme?: (theme: string) => void;
    } = {},
    timeoutMs = 60_000,
): Promise<Connection | null> {
    const widgetId = params.get("widgetId") ?? params.get("matrix_widget_id");
    const parentUrl = params.get("parentUrl");
    const embedded = !!widgetId && window.parent !== window;
    if (!embedded) return null;

    // Element Desktop frames widgets from vector://vector, whose origin is the
    // literal string "null". Treat that as unknown and let the SDK post to "*".
    let origin: string | null = null;
    try {
        if (parentUrl) {
            const o = new URL(parentUrl).origin;
            origin = o !== "null" ? o : null;
        }
    } catch {
        /* keep null */
    }

    const api = new WidgetApi(widgetId!, origin);

    // Every capability before start(): the Player has no MSC2974 renegotiation,
    // so requestCapability() after the handshake throws there. On Element a later
    // request works but costs the user a second consent prompt.
    for (const c of CAPABILITIES) api.requestCapability(c);

    const ack = (ev: CustomEvent<IWidgetApiRequest>): void => {
        ev.preventDefault();
        api.transport.reply(ev.detail, {});
    };

    // Room state arrives here: the full set right after approval, then every
    // change. Prefer this over readStateEvents — the Player answers that from
    // the last 50 timeline events, so old state scrolls out.
    api.on(`action:${WidgetApiToWidgetAction.UpdateState}`, (ev: CustomEvent<IWidgetApiRequest>) => {
        ack(ev);
        const state = (ev.detail.data as { state?: IRoomEvent[] }).state ?? [];
        handlers.onState?.(state);
    });
    // Live timeline events matching an approved receive.event capability. Element
    // also delivers our own sends back through here, which is how the widget sees
    // its own answers land.
    api.on(`action:${WidgetApiToWidgetAction.SendEvent}`, (ev: CustomEvent<IWidgetApiRequest>) => {
        ack(ev);
        handlers.onEvent?.(ev.detail.data as unknown as IRoomEvent);
    });
    api.on(`action:${WidgetApiToWidgetAction.ThemeChange}`, (ev: CustomEvent<IWidgetApiRequest>) => {
        ack(ev);
        const name = (ev.detail.data as { name?: string }).name;
        if (name) handlers.onTheme?.(name);
    });
    api.on(`action:${WidgetApiToWidgetAction.LanguageChange}`, ack);
    api.on(`action:${WidgetApiToWidgetAction.WidgetConfig}`, ack);

    // The default 10 s is short when a human is answering a dialog on the other side.
    api.transport.timeoutSeconds = 30;

    const approved: Capability[] = [];
    // hasCapability() falls back to the *requested* list until the host has
    // notified, so read the approved set off the event instead.
    api.once("action:notify_capabilities", (ev: CustomEvent<IWidgetApiRequest>) => {
        approved.push(...((ev.detail.data as { approved?: Capability[] }).approved ?? []));
    });

    api.start();
    // Harmless when the host negotiates on iframe load; required when the widget
    // event carries waitForIframeLoad:false. Never send it twice.
    api.sendContentLoaded().catch(() => undefined);

    await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        api.once("ready", () => {
            clearTimeout(timer);
            resolve();
        });
    });

    // The Player mounts the widget once before consent (everything denied),
    // shows the dialog, then remounts it with the approved set. The first
    // instance correctly sees nothing approved and is discarded — that is the
    // lifecycle working. Do nothing irreversible before this point.
    return { api, approved };
}

/** Initial theme: the URL hint first, then the system preference. */
export function initialTheme(params: Params): "light" | "dark" {
    const hint = params.get("theme");
    if (hint?.startsWith("dark")) return "dark";
    if (hint?.startsWith("light")) return "light";
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
