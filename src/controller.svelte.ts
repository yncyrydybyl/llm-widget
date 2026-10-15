/*
 * Ties the room, the request queue and the model together. One instance, created
 * in main.ts. Reactive with runes so App.svelte can render it directly.
 */
import type { IRoomEvent, WidgetApi } from "matrix-widget-api";
import { CAPABILITIES, connect, initialTheme, readParams, type Params } from "./widget-connect";
import { DEFAULT_MODEL, EchoEngine, MODELS, availableModels, isCached, loadWebLlm, webGpuStatus, webLlmId, type Engine, type ModelInfo } from "./llm";
import {
    Transcript,
    answerContent,
    buildMessages,
    contextLines,
    parseTrigger,
    stripThinking,
    toLine,
    type Line,
} from "./room";

export type RoomStatus = "standalone" | "connecting" | "ready" | "no-permission";
export type EngineStatus = "idle" | "loading" | "ready" | "error";
export type JobStatus = "waiting" | "generating" | "posted" | "done" | "skipped" | "error";

export interface Job {
    id: number;
    sender: string;
    question: string;
    /** The room message that asked; null for a private question. */
    triggerEventId: string | null;
    status: JobStatus;
    output: string;
    error?: string;
}

export interface Settings {
    modelId: string;
    prefix: string;
    answerEveryone: boolean;
    postToRoom: boolean;
    contextSize: number;
}

const SETTINGS_KEY = "llm-widget.settings";
const MAX_CONTEXT_CHARS = 8000; // leaves room for the answer in a 4k-token window
const LOCAL_USER = "@you:local";

function loadSettings(): Settings {
    const defaults: Settings = {
        modelId: DEFAULT_MODEL,
        prefix: "!ai",
        answerEveryone: false,
        postToRoom: true,
        contextSize: 30,
    };
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (!raw) return defaults;
        const s = { ...defaults, ...(JSON.parse(raw) as Partial<Settings>) };
        if (!MODELS.some((m) => m.id === s.modelId)) s.modelId = DEFAULT_MODEL;
        return s;
    } catch {
        return defaults;
    }
}

export class Controller {
    readonly params: Params = readParams();
    /** A hint from the URL, used only to pick whose requests to answer. */
    readonly userId: string | null = this.params.get("matrix_user_id") ?? this.params.get("userId");
    readonly useEcho = this.params.get("engine") === "echo";

    theme = $state<"light" | "dark">(initialTheme(this.params));
    room = $state<RoomStatus>("connecting");
    missing = $state<string[]>([]);
    settings = $state<Settings>(loadSettings());

    engineStatus = $state<EngineStatus>("idle");
    progress = $state(0);
    progressText = $state("");
    engineError = $state("");
    gpuProblem = $state<string | null>(null);
    /** Until probed, assume f16 so the list does not jump on most machines. */
    f16 = $state(true);
    cached = $state<Record<string, boolean>>({});

    lines = $state<Line[]>([]);
    jobs = $state<Job[]>([]);

    private api: WidgetApi | null = null;
    private engine: Engine | null = null;
    private transcript = new Transcript();
    /** Events read as history at startup: context only, never answered. */
    private live = false;
    private nextJob = 1;
    private busy = false;
    private abort: AbortController | null = null;

    get model(): string {
        return this.engine?.modelId ?? "";
    }

    get models(): ModelInfo[] {
        return availableModels(this.f16);
    }

    get selected(): ModelInfo | undefined {
        return this.models.find((m) => m.id === this.settings.modelId);
    }

    get answersOthers(): boolean {
        // Without our own user id we cannot tell whose request is whose.
        return this.settings.answerEveryone || !this.userId;
    }

    saveSettings(): void {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
        } catch {
            /* private window: settings just do not persist */
        }
    }

    async start(): Promise<void> {
        void webGpuStatus().then((g) => {
            this.gpuProblem = this.useEcho ? null : g.problem;
            this.f16 = g.f16;
            if (!this.models.some((m) => m.id === this.settings.modelId)) this.settings.modelId = this.models[0].id;
            void this.refreshCache();
        });

        const conn = await connect(this.params, {
            onEvent: (ev) => this.onRoomEvent(ev, true),
            onTheme: (name) => (this.theme = name.startsWith("dark") ? "dark" : "light"),
        });
        if (!conn) {
            this.room = "standalone";
            this.live = true;
            return;
        }
        this.api = conn.api;
        const needed = CAPABILITIES.filter((c) => c !== "io.element.requires_client");
        this.missing = needed.filter((c) => !conn.approved.includes(c));
        // The Player's first, pre-consent mount lands here with nothing approved.
        // That instance is discarded after the dialog; just say so and wait.
        if (this.missing.length === needed.length) {
            this.room = "no-permission";
            return;
        }
        this.room = "ready";
        await this.readHistory();
        this.live = true;
    }

    private async readHistory(): Promise<void> {
        if (!this.api) return;
        for (const msgtype of ["m.text", "m.notice"]) {
            try {
                const events = await this.api.readRoomEvents("m.room.message", 50, msgtype);
                for (const ev of events) this.onRoomEvent(ev, false);
            } catch {
                /* host without read_events, or not approved: live events only */
            }
        }
    }

    private onRoomEvent(ev: IRoomEvent, live: boolean): void {
        const line = toLine(ev);
        if (!line || !this.transcript.add(line)) return;
        this.lines = this.transcript.lines();
        // History is context; only messages that arrive while we listen are requests.
        if (live && this.live) this.maybeAnswer(line);
    }

    private maybeAnswer(line: Line): void {
        if (line.fromModel) return;
        const question = parseTrigger(line.body, this.settings.prefix);
        if (question === null) return;
        const mine = !this.userId || line.sender === this.userId || this.room === "standalone";
        if (!mine && !this.answersOthers) return;
        this.enqueue({ sender: line.sender, question, triggerEventId: line.eventId });
    }

    /** Standalone: a local message, handled exactly like a room message. */
    say(body: string): void {
        const line: Line = { eventId: `local-${Date.now()}-${Math.random()}`, sender: LOCAL_USER, body, ts: Date.now(), fromModel: false };
        this.transcript.add(line);
        this.lines = this.transcript.lines();
        if (parseTrigger(body, this.settings.prefix) !== null) this.maybeAnswer(line);
    }

    /** In a room: ask about the conversation without posting anything. */
    askPrivately(question: string): void {
        this.enqueue({ sender: this.userId ?? LOCAL_USER, question, triggerEventId: null });
    }

    private enqueue(j: Omit<Job, "id" | "status" | "output">): void {
        this.jobs = [{ ...j, id: this.nextJob++, status: "waiting" as JobStatus, output: "" }, ...this.jobs].slice(0, 50);
        void this.pump();
    }

    private job(id: number): Job | undefined {
        return this.jobs.find((j) => j.id === id);
    }

    /** One generation at a time, oldest request first. */
    private async pump(): Promise<void> {
        if (this.busy || !this.engine) return;
        const next = [...this.jobs].reverse().find((j) => j.status === "waiting");
        if (!next) return;
        this.busy = true;
        const id = next.id;
        const engine = this.engine;
        try {
            const context = contextLines(
                this.transcript.lines(),
                next.triggerEventId,
                this.settings.contextSize,
                MAX_CONTEXT_CHARS,
            );
            const messages = buildMessages(context, next, this.settings.prefix);
            this.job(id)!.status = "generating";
            this.abort = new AbortController();
            const raw = await engine.chat(
                messages,
                (soFar) => {
                    const j = this.job(id);
                    if (j) j.output = stripThinking(soFar) || "…thinking";
                },
                this.abort.signal,
            );
            const answer = stripThinking(raw);
            const j = this.job(id)!;
            j.output = answer;
            await this.deliver(j, answer, engine.modelId);
        } catch (e) {
            const j = this.job(id);
            if (j) {
                j.status = "error";
                j.error = e instanceof Error ? e.message : String(e);
            }
        } finally {
            this.abort = null;
            this.busy = false;
            void this.pump();
        }
    }

    private async deliver(j: Job, answer: string, model: string): Promise<void> {
        const trigger = j.triggerEventId;
        if (!trigger || !this.api || !this.settings.postToRoom) {
            if (trigger && this.room === "standalone") {
                const line: Line = { eventId: `local-answer-${j.id}`, sender: "@model:local", body: answer, ts: Date.now(), fromModel: true, inReplyTo: trigger };
                this.transcript.add(line);
                this.lines = this.transcript.lines();
            }
            j.status = "done";
            return;
        }
        if (!answer) {
            j.status = "skipped";
            j.error = "The model returned nothing.";
            return;
        }
        // Someone else's widget may have answered while we were generating.
        if (this.transcript.answered(trigger)) {
            j.status = "skipped";
            j.error = "Another widget answered first.";
            return;
        }
        await this.api.sendRoomEvent("m.room.message", answerContent(answer, trigger, model));
        j.status = "posted";
    }

    stop(): void {
        this.abort?.abort();
    }

    async loadModel(): Promise<void> {
        if (this.engineStatus === "loading") return;
        this.engineStatus = "loading";
        this.engineError = "";
        this.progress = 0;
        this.progressText = "Starting…";
        try {
            await this.engine?.unload();
            this.engine = null;
            this.engine = this.useEcho
                ? new EchoEngine()
                : await loadWebLlm(webLlmId(this.selected ?? this.models[0], this.f16), (p) => {
                      this.progress = p.fraction;
                      this.progressText = p.text;
                  });
            this.engineStatus = "ready";
            void this.refreshCache();
            void this.pump();
        } catch (e) {
            this.engineStatus = "error";
            this.engineError = e instanceof Error ? e.message : String(e);
        }
    }

    async unloadModel(): Promise<void> {
        this.stop();
        await this.engine?.unload();
        this.engine = null;
        this.engineStatus = "idle";
    }

    private async refreshCache(): Promise<void> {
        if (this.useEcho) return;
        const entries = await Promise.all(this.models.map(async (m) => [m.id, await isCached(webLlmId(m, this.f16))] as const));
        this.cached = Object.fromEntries(entries);
    }
}
