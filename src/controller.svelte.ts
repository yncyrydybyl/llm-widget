/*
 * Ties the room, the request queue and the model together. One instance, created
 * in main.ts. Reactive with runes so App.svelte can render it directly.
 */
import type { IRoomEvent, WidgetApi } from "matrix-widget-api";
import { CAPABILITIES, connect, initialTheme, readParams, type Params } from "./widget-connect";
import { DEFAULT_MODEL, EchoEngine, MODELS, availableModels, isCached, loadWebLlm, webGpuStatus, webLlmId, type Engine, type ModelInfo, type Usage } from "./llm";
import { plan, type Plan } from "./commands";
import {
    HEARTBEAT_MS,
    NO_DONATION,
    PRESENCE_TYPE,
    Roster,
    addDonation,
    presenceContent,
    toPresence,
    type Donation,
    type Donor,
    type Summary,
} from "./presence";
import { download, readable } from "./media";
import { RECOGNISERS, VOICES, embed, guessLanguage, ocr, pdfText, speak, transcribe } from "./ml";
import { chunk, dot, excerpts, topK } from "./search";
import {
    Transcript,
    answerContent,
    buildPrompt,
    splitText,
    type ChatMessage,
    type Subject,
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
    /** What the question asks the model to do, resolved when the job is created. */
    plan: Plan;
    /** The room message that asked; null for a private question. */
    triggerEventId: string | null;
    status: JobStatus;
    output: string;
    error?: string;
    /** Shown under the request: what had to be cut to fit the model. */
    note?: string;
    /** GPU resets survived so far; the job gives up after MAX_GPU_RETRIES. */
    gpuRetries?: number;
    /** Tokens and model time of the successful attempt. */
    usage?: Usage;
    ms?: number;
}

export interface Settings {
    modelId: string;
    prefix: string;
    answerEveryone: boolean;
    postToRoom: boolean;
    contextSize: number;
    /** Find relevant older messages and document parts with embeddings (downloads a small model). */
    search: boolean;
    /** Piper voice for reading answers aloud; "auto" picks by language. */
    voice: string;
    /** Whisper variant for voice messages (ml.ts RECOGNISERS). */
    recogniser: string;
    /** Per model (WebLLM id): the largest prompt part this GPU processes in one pass. */
    chunks: Record<string, number>;
}

const SETTINGS_KEY = "llm-widget.settings";
/*
 * Prompt budget in characters. The models have a 4096-token window and we reserve
 * 768 tokens for the answer; at a conservative ~3 characters per token (German,
 * markup and URLs tokenise worse than English prose) 9000 characters fit. If the
 * model still reports an overflow, the request is retried with half the budget.
 */
const PROMPT_BUDGET = 9000;
/*
 * Some GPU drivers reset the device when one prefill pass gets too heavy
 * (VK_ERROR_DEVICE_LOST on a Radeon 860M with Mesa: ~1000 tokens for a 360M model,
 * a few hundred for 4B). WebLLM's own prefill chunk size is compiled into the model
 * library, so we split long prompts ourselves into rounds (see prefillRounds). On a
 * reset we reload the model, halve the part size for this model on this machine,
 * remember it, and retry.
 */
const MIN_CHUNK = 300;
const MAX_GPU_RETRIES = 4;
const isGpuLoss = (msg: string): boolean => /device (was )?lost|GPUBuffer|mapAsync|DEVICE_LOST/i.test(msg);
const LOCAL_USER = "@you:local";
/** A subject (document, transcript) longer than this is digested or searched rather than cut. */
const SUBJECT_MAX = 5000;
/** Digest at most this many parts of a long document, one model call each. */
const MAX_DIGEST_PARTS = 8;
/** Extracted text posted as is (transcribe, read) is cut here. */
const MAX_EXTRACT_POST = 8000;
/** Older messages added to the context when searching the history. */
const RELEVANT_LINES = 6;
const DEVICE_KEY = "llm-widget.device";
const DONATED_KEY = "llm-widget.donated";

const randomId = (): string => crypto.randomUUID().slice(0, 13);

/** A random id per browser, so this device's totals are counted once. */
function deviceId(): string {
    try {
        let id = localStorage.getItem(DEVICE_KEY);
        if (!id) {
            id = randomId();
            localStorage.setItem(DEVICE_KEY, id);
        }
        return id;
    } catch {
        return randomId();
    }
}

/** This device's donation, per room widget (the widget id is the same for every member of the room). */
function loadDonated(widgetId: string): Donation {
    try {
        const all = JSON.parse(localStorage.getItem(DONATED_KEY) ?? "{}") as Record<string, Donation>;
        return { ...NO_DONATION, ...all[widgetId] };
    } catch {
        return { ...NO_DONATION };
    }
}

function saveDonated(widgetId: string, d: Donation): void {
    try {
        const all = JSON.parse(localStorage.getItem(DONATED_KEY) ?? "{}") as Record<string, Donation>;
        all[widgetId] = d;
        localStorage.setItem(DONATED_KEY, JSON.stringify(all));
    } catch {
        /* private window: totals restart with the page */
    }
}

function loadSettings(): Settings {
    const defaults: Settings = {
        modelId: DEFAULT_MODEL,
        prefix: "!ai",
        answerEveryone: false,
        postToRoom: true,
        contextSize: 30,
        search: false,
        voice: "auto",
        recogniser: "base",
        chunks: {},
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

    /** Widgets open in the room and who can answer; refreshed on every announcement. */
    presence = $state<Summary | null>(null);
    donors = $state<Donor[]>([]);
    readonly instance = randomId();
    private readonly device = deviceId();
    private readonly widgetId = this.params.get("widgetId") ?? this.params.get("matrix_widget_id") ?? "";
    donated = $state<Donation>(loadDonated(this.widgetId));
    private roster = new Roster();
    private announceTimer: ReturnType<typeof setTimeout> | null = null;

    private api: WidgetApi | null = null;
    private engine: Engine | null = null;
    private transcript = new Transcript();
    /** Text of attachments, by event id: transcripts, OCR, PDF text. */
    private extracted = new Map<string, Promise<string>>();
    /** Embeddings of room messages, by event id. */
    private vectors = new Map<string, number[]>();
    /** Events read as history at startup: context only, never answered. */
    private live = false;
    private nextJob = 1;
    private busy = false;
    private abort: AbortController | null = null;
    /** Size of the prompt last sent, to size the parts after a GPU reset. */
    private lastPromptChars = 0;

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
        // "Answer everyone" and the prefix are part of what others see.
        this.announceSoon();
    }

    async start(): Promise<void> {
        void webGpuStatus().then((g) => {
            this.gpuProblem = this.useEcho ? null : g.problem;
            // `f16=0` in the fragment forces the f32 builds (for GPUs whose f16 path misbehaves).
            this.f16 = g.f16 && this.params.get("f16") !== "0";
            if (!this.models.some((m) => m.id === this.settings.modelId)) this.settings.modelId = this.models[0].id;
            void this.refreshCache();
        });

        const conn = await connect(this.params, {
            onEvent: (ev) => (ev.type === PRESENCE_TYPE ? this.onPresence(ev, true) : this.onRoomEvent(ev, true)),
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
        await this.readPresence();
        this.startPresence();
    }

    private async readPresence(): Promise<void> {
        try {
            const events = await this.api!.readRoomEvents(PRESENCE_TYPE, 50);
            for (const ev of events) this.onPresence(ev, false);
        } catch {
            /* not approved or not supported: live announcements only */
        }
    }

    /** Announce now (asking the others to do the same), then keep announcing while open. */
    private startPresence(): void {
        if (this.missing.some((c) => c.includes(PRESENCE_TYPE))) return;
        void this.announce(true);
        setInterval(() => void this.announce(), HEARTBEAT_MS);
        // Announcements expire; recount now and then even when nothing arrives.
        setInterval(() => this.refreshPresence(), 30_000);
        // Best effort: a closing tab may not get the event out; the TTL covers that.
        window.addEventListener("pagehide", () => void this.announce(false, false));
    }

    private onPresence(ev: IRoomEvent, live: boolean): void {
        const p = toPresence(ev);
        if (!p || !this.roster.add(p)) return;
        this.refreshPresence();
        // A widget just opened and asks who is here: answer, after a random
        // delay so several widgets do not all send at the same moment. Always
        // answer: the newcomer may have read the history just before our last
        // announcement. Probes arriving together share one answer.
        if (live && p.probe && p.instance !== this.instance) this.announceSoon(500 + Math.random() * 2500);
    }

    private refreshPresence(): void {
        this.presence = this.roster.summary(Date.now(), this.userId, this.instance);
        this.donors = this.roster.donors();
    }

    /** Coalesces changes (model loaded, settings, a donation) into one announcement. */
    private announceSoon(delay = 1500): void {
        if (this.room !== "ready" || this.announceTimer) return;
        this.announceTimer = setTimeout(() => {
            this.announceTimer = null;
            void this.announce();
        }, delay);
    }

    private async announce(probe = false, online = true): Promise<void> {
        if (!this.api || this.room !== "ready") return;
        const content = {
            instance: this.instance,
            device: this.device,
            online,
            model: this.engineStatus === "ready" ? this.model : null,
            everyone: this.answersOthers,
            prefix: this.settings.prefix,
            donated: { ...this.donated },
            ...(probe ? { probe } : {}),
        };
        // Count ourselves at once; the host's echo of the event changes nothing.
        this.roster.add({ ...content, sender: this.userId ?? "", ts: Date.now() });
        this.refreshPresence();
        try {
            await this.api.sendRoomEvent(PRESENCE_TYPE, presenceContent(content));
        } catch {
            /* not allowed or rate-limited: the next heartbeat tries again */
        }
    }

    private async readHistory(): Promise<void> {
        if (!this.api) return;
        for (const msgtype of ["m.text", "m.notice", "m.audio", "m.image", "m.file"]) {
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
        this.enqueue({ sender: line.sender, question, triggerEventId: line.eventId, plan: plan(question, this.transcript.lines(), line, this.settings.prefix) });
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
        // The question box takes the same shortcuts, without the trigger.
        const q = parseTrigger(question, this.settings.prefix) ?? question;
        this.enqueue({ sender: this.userId ?? LOCAL_USER, question: q, triggerEventId: null, plan: plan(q, this.transcript.lines(), null, this.settings.prefix) });
    }

    private enqueue(j: Omit<Job, "id" | "status" | "output">): void {
        const id = this.nextJob++;
        this.jobs = [{ ...j, id, status: "waiting" as JobStatus, output: "" }, ...this.jobs].slice(0, 50);
        if (j.plan.fixed !== undefined) void this.answerFixed(id, j.plan.fixed);
        else if (j.plan.extract) void this.answerExtract(id);
        else void this.pump();
    }

    /** Transcripts and OCR: posted as they are, without waiting for the LLM. */
    private async answerExtract(id: number): Promise<void> {
        const j = this.job(id)!;
        j.status = "generating";
        try {
            const text = (await this.textOf(id, j.plan.target!)) || "(no text found)";
            const cut = text.length > MAX_EXTRACT_POST;
            j.output = cut ? `${text.slice(0, MAX_EXTRACT_POST)}\n[…${text.length - MAX_EXTRACT_POST} more characters]` : text;
            j.note = undefined;
            await this.deliver(j, j.output, "");
        } catch (e) {
            j.status = "error";
            j.error = e instanceof Error ? e.message : String(e);
        }
    }

    /** The text of an attachment, extracted once per event. */
    private textOf(id: number, target: NonNullable<Plan["target"]>): Promise<string> {
        const note = (text: string): void => {
            const j = this.job(id);
            if (j) j.note = text;
        };
        const media = target.media;
        if (!media) return Promise.resolve(target.body);
        let p = this.extracted.get(target.eventId);
        if (!p) {
            p = (async () => {
                if (!this.api) throw new Error("Attachments can only be read inside a room.");
                const how = readable(media);
                if (!how) throw new Error(`Cannot read ${media.name}.`);
                note(`Downloading ${media.name}…`);
                const blob = await download(this.api, media);
                if (how === "text") return (await blob.text()).trim();
                if (how === "pdf") return pdfText(blob, note);
                if (how === "ocr") return ocr(blob, note);
                const rec = RECOGNISERS.find((r) => r.id === this.settings.recogniser) ?? RECOGNISERS[0];
                // The room's language: the small Whisper models misdetect short messages.
                const recent = this.transcript.lines().filter((l) => !l.media && !l.fromModel).slice(-30).map((l) => l.body).join(" ");
                return transcribe(blob, rec, note, guessLanguage(recent));
            })();
            this.extracted.set(target.eventId, p);
            p.catch(() => this.extracted.delete(target.eventId));
        }
        return p;
    }

    /** Help and usage errors: no model needed, so not queued behind generations. */
    private async answerFixed(id: number, text: string): Promise<void> {
        const j = this.job(id)!;
        j.status = "generating";
        j.output = text;
        // Every open widget may answer; a random pause lets the first answer
        // arrive so the others see it and stay quiet.
        if (j.triggerEventId && this.api) await new Promise((r) => setTimeout(r, Math.random() * 3000));
        await this.deliver(j, text, "");
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
            this.job(id)!.status = "generating";
            this.abort = new AbortController();
            const started = performance.now();
            let usage: Usage | undefined;
            const add = (u: Usage): void => {
                usage = { promptTokens: (usage?.promptTokens ?? 0) + u.promptTokens, completionTokens: (usage?.completionTokens ?? 0) + u.completionTokens };
            };
            const prep = await this.prepare(id, engine, next, add);
            const raw = await this.generate(id, engine, next, prep, add);
            const j0 = this.job(id);
            if (j0) {
                j0.usage = usage;
                j0.ms = Math.round(performance.now() - started);
            }
            const answer = stripThinking(raw);
            const j = this.job(id)!;
            j.output = answer;
            await this.deliver(j, answer, engine.modelId);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const j = this.job(id);
            if (isGpuLoss(msg) && !this.abort?.signal.aborted) {
                this.recoverFromGpuLoss(engine, j);
                return;
            }
            if (j) {
                j.status = "error";
                j.error = msg;
            }
        } finally {
            this.abort = null;
            this.busy = false;
            void this.pump();
        }
    }

    /**
     * What the model reads besides the recent conversation: the subject (an
     * attachment's text, digested or searched when long) and, with search on,
     * the older messages most related to a question.
     */
    private async prepare(id: number, engine: Engine, request: Job, onUsage: (u: Usage) => void): Promise<{ subject?: Subject; lines: Line[] }> {
        const { plan } = request;
        const note = (text: string): void => {
            const j = this.job(id);
            if (j) j.note = text;
        };
        let lines = this.transcript.lines();
        let subject: Subject | undefined = plan.text ? { from: null, body: plan.text } : undefined;
        if (plan.target) {
            const body = await this.textOf(id, plan.target);
            subject = { from: plan.target.media ? `${plan.target.sender} (${plan.target.body})` : plan.target.sender, body };
        }
        if (subject && subject.body.length > SUBJECT_MAX) {
            if (plan.command === null && this.settings.search) {
                note("Searching the document for the relevant parts…");
                const parts = chunk(subject.body);
                const [q] = await embed([plan.instruction], "query", note);
                const vs = await embed(parts, "passage", note);
                subject = { ...subject, body: excerpts(parts, vs.map((v) => dot(q, v)), SUBJECT_MAX) };
            } else {
                subject = { ...subject, body: await this.digest(id, engine, subject.body, onUsage) };
            }
        }
        if (this.settings.search && plan.command === null && plan.scope === "recent") lines = await this.withRelevant(lines, request, note);
        return { subject, lines };
    }

    /** Summarises a long text part by part; the answer is then built from the summaries. */
    private async digest(id: number, engine: Engine, text: string, onUsage: (u: Usage) => void): Promise<string> {
        const all = splitText(text, SUBJECT_MAX - 500);
        const parts = all.slice(0, MAX_DIGEST_PARTS);
        const out: string[] = [];
        for (let i = 0; i < parts.length; i++) {
            const j = this.job(id);
            if (j) j.note = `Long text: summarising part ${i + 1} of ${parts.length}${all.length > parts.length ? ` (of ${all.length}; the rest is skipped)` : ""}…`;
            const messages: ChatMessage[] = [
                { role: "system", content: "You summarise documents faithfully and never add facts." },
                {
                    role: "user",
                    content: `Part ${i + 1} of ${parts.length} of a document:\n<document>\n${parts[i]}\n</document>\n\nSummarise this part in at most six bullet points, in its own language. Keep names, numbers and dates.`,
                },
            ];
            const r = await engine.chat(messages, () => undefined, { signal: this.abort?.signal, chunkChars: this.settings.chunks[engine.modelId], onUsage });
            if (this.abort?.signal.aborted) throw new Error("Stopped.");
            out.push(`Summary of part ${i + 1}:\n${stripThinking(r)}`);
        }
        return out.join("\n\n");
    }

    /** The recent window plus the older messages closest to the question. */
    private async withRelevant(lines: Line[], request: Job, note: (t: string) => void): Promise<Line[]> {
        const end = request.triggerEventId ? lines.findIndex((l) => l.eventId === request.triggerEventId) : lines.length;
        const before = lines.slice(0, end === -1 ? lines.length : end);
        const older = before.slice(0, Math.max(0, before.length - this.settings.contextSize)).filter((l) => !l.media);
        if (!older.length) return lines;
        const missing = older.filter((l) => !this.vectors.has(l.eventId));
        if (missing.length) {
            note(`Indexing ${missing.length} older messages…`);
            for (let i = 0; i < missing.length; i += 32) {
                const batch = missing.slice(i, i + 32);
                const vs = await embed(batch.map((l) => l.body.slice(0, 1000)), "passage", note);
                batch.forEach((l, k) => this.vectors.set(l.eventId, vs[k]));
            }
        }
        const [q] = await embed([request.plan.instruction], "query", note);
        const keep = new Set(topK(older.map((l) => dot(q, this.vectors.get(l.eventId)!)), RELEVANT_LINES).map((i) => older[i].eventId));
        note(`Found ${keep.size} related older messages.`);
        // Recent window, the related older lines, and everything after (the trigger).
        const recentFrom = before.length - this.settings.contextSize;
        return lines.filter((l, i) => i >= recentFrom || keep.has(l.eventId));
    }

    /** Generates within the window, shrinking the prompt when the model says it is too long. */
    private async generate(
        id: number,
        engine: Engine,
        request: Job,
        prep: { subject?: Subject; lines: Line[] },
        onUsage: (u: Usage) => void,
    ): Promise<string> {
        for (let budget = PROMPT_BUDGET; ; budget = Math.floor(budget / 2)) {
            const { plan } = request;
            const { subject } = prep;
            const prompt = buildPrompt(
                prep.lines,
                { sender: request.sender, question: plan.instruction, triggerEventId: request.triggerEventId, subject, scope: plan.scope },
                {
                    prefix: this.settings.prefix,
                    maxLines: (plan.maxLines ?? this.settings.contextSize) + (prep.lines.length < this.transcript.lines().length ? RELEVANT_LINES : 0),
                    budgetChars: budget,
                },
            );
            const j = this.job(id);
            const shortened = prompt.truncated ? "Request shortened to fit the model; " : "";
            const reset = j?.gpuRetries ? `retry ${j.gpuRetries} after a GPU reset; ` : "";
            const describe = (rounds: string): void => {
                const j = this.job(id);
                if (j && (shortened || reset || rounds))
                    j.note = `${shortened}${reset}${rounds}${prompt.context} messages of context.`;
            };
            describe("");
            this.lastPromptChars = prompt.messages.reduce((n, m) => n + m.content.length, 0);
            try {
                return await engine.chat(
                    prompt.messages,
                    (soFar) => {
                        const j = this.job(id);
                        if (j) j.output = stripThinking(soFar) || "…thinking";
                    },
                    {
                        signal: this.abort?.signal,
                        chunkChars: this.settings.chunks[engine.modelId],
                        onRound: (i, of) => describe(`reading part ${i} of ${of}; `),
                        onUsage,
                    },
                );
            } catch (e) {
                if (!String(e).includes("ContextWindowSizeExceeded") || budget < 1000) throw e;
            }
        }
    }

    /** The largest single prefill this GPU handled for the model, if it ever failed. */
    chunk(modelId: string): number | undefined {
        return this.settings.chunks[modelId];
    }

    /** The device is gone with everything on it: shrink, reload, requeue. */
    private recoverFromGpuLoss(lost: Engine, j: Job | undefined): void {
        const modelId = lost.modelId;
        const current = Math.min(this.chunk(modelId) ?? Infinity, this.lastPromptChars || PROMPT_BUDGET);
        const smaller = Math.max(MIN_CHUNK, Math.floor(current / 2));
        this.settings.chunks[modelId] = smaller;
        this.saveSettings();
        if (j) {
            j.gpuRetries = (j.gpuRetries ?? 0) + 1;
            j.output = "";
            if (j.gpuRetries > MAX_GPU_RETRIES) {
                j.status = "error";
                j.error = "The GPU reset repeatedly on this request. Try a smaller model or a shorter request.";
            } else {
                j.status = "waiting";
                j.note = `GPU reset; reloading the model and retrying in parts of at most ${smaller} characters.`;
            }
        }
        // Drop the engine now so pump() idles; the reload pumps the queue when ready.
        // Unloading a lost device can hang, so the worker is not waited for.
        this.engine = null;
        this.engineStatus = "idle";
        void lost.unload();
        void this.loadModel();
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
        await this.api.sendRoomEvent("m.room.message", answerContent(answer, trigger, model, { usage: j.usage, ms: j.ms }));
        j.status = "posted";
        // Only model answers posted to the room count as donated; private
        // questions are one's own, and help texts cost nothing.
        if (!j.usage) return;
        this.donated = addDonation(this.donated, {
            answers: 1,
            promptTokens: j.usage?.promptTokens ?? 0,
            completionTokens: j.usage?.completionTokens ?? 0,
            gpuMs: j.ms ?? 0,
        });
        saveDonated(this.widgetId, this.donated);
        this.announceSoon();
    }

    /** Reads text aloud with Piper, on the CPU. Resolves when playback ends. */
    async readAloud(text: string, onNote?: (t: string) => void): Promise<void> {
        const lang = guessLanguage(text) === "german" ? "de" : "en";
        const voice = VOICES.find((v) => v.id === this.settings.voice) ?? VOICES.find((v) => v.lang === lang)!;
        const wav = await speak(text.replace(/[*_#`>]/g, ""), voice.id, onNote);
        const url = URL.createObjectURL(wav);
        try {
            const audio = new Audio(url);
            await audio.play();
            await new Promise<void>((resolve) => {
                audio.onended = () => resolve();
                audio.onerror = () => resolve();
            });
        } finally {
            URL.revokeObjectURL(url);
        }
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
            this.announceSoon();
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
        this.announceSoon();
    }

    private async refreshCache(): Promise<void> {
        if (this.useEcho) return;
        const entries = await Promise.all(this.models.map(async (m) => [m.id, await isCached(webLlmId(m, this.f16))] as const));
        this.cached = Object.fromEntries(entries);
    }
}
