/*
 * Pure room logic: turning timeline events into a transcript, deciding which
 * messages are requests for the model, and building the prompt. No widget API and
 * no DOM here, so all of it is unit-tested.
 */
import type { IRoomEvent } from "matrix-widget-api";
import { describe, toMedia, type Media } from "./media";

/** Marks our own answers so they are recognised as model output, also in other widgets. */
export const MARKER = "de.datanauten.llm_widget";

export interface Line {
    eventId: string;
    sender: string;
    body: string;
    ts: number;
    /** A notice sent by this widget (any instance, any user). */
    fromModel: boolean;
    /** For model answers: the event they reply to. */
    inReplyTo?: string;
    /** Voice messages, images and files; `body` then describes the attachment. */
    media?: Media;
}

interface MessageContent {
    msgtype?: string;
    body?: unknown;
    "m.relates_to"?: { "m.in_reply_to"?: { event_id?: string }; rel_type?: string };
    [MARKER]?: unknown;
}

/** Drops the quoted "> <@user> …" fallback that rich replies prepend to the body. */
export function stripReplyFallback(body: string): string {
    const lines = body.split("\n");
    let i = 0;
    while (i < lines.length && lines[i].startsWith(">")) i++;
    if (i === 0) return body;
    // The fallback is followed by one blank line.
    if (lines[i] === "") i++;
    return lines.slice(i).join("\n");
}

export function toLine(ev: IRoomEvent): Line | null {
    if (ev.type !== "m.room.message") return null;
    const c = (ev.content ?? {}) as MessageContent;
    // Edits arrive as new events; keeping only originals is good enough here.
    if (c["m.relates_to"]?.rel_type === "m.replace") return null;
    const media = toMedia(c);
    if (media) {
        return { eventId: ev.event_id, sender: ev.sender, body: describe(media), ts: ev.origin_server_ts ?? 0, fromModel: false, media };
    }
    if (c.msgtype !== "m.text" && c.msgtype !== "m.notice") return null;
    if (typeof c.body !== "string") return null;
    const fromModel = c.msgtype === "m.notice" && MARKER in c;
    return {
        eventId: ev.event_id,
        sender: ev.sender,
        body: stripReplyFallback(c.body),
        ts: ev.origin_server_ts ?? 0,
        fromModel,
        inReplyTo: c["m.relates_to"]?.["m.in_reply_to"]?.event_id,
    };
}

/** `!ai what did we decide?` → `what did we decide?`; null when it is not a request. */
export function parseTrigger(body: string, prefix: string): string | null {
    const p = prefix.trim();
    if (!p) return null;
    const text = body.trimStart();
    if (text.slice(0, p.length).toLowerCase() !== p.toLowerCase()) return null;
    const rest = text.slice(p.length);
    // "!aix" is not "!ai x".
    if (rest !== "" && !/^[\s:,]/.test(rest)) return null;
    return rest.replace(/^[\s:,]+/, "").trim();
}

/** Ordered, de-duplicated transcript. Events can arrive twice (backlog + live). */
export class Transcript {
    private byId = new Map<string, Line>();

    add(line: Line): boolean {
        if (this.byId.has(line.eventId)) return false;
        this.byId.set(line.eventId, line);
        return true;
    }

    has(eventId: string): boolean {
        return this.byId.has(eventId);
    }

    /** True once any widget instance has posted an answer to this event. */
    answered(eventId: string): boolean {
        for (const l of this.byId.values()) if (l.fromModel && l.inReplyTo === eventId) return true;
        return false;
    }

    lines(): Line[] {
        return [...this.byId.values()].sort((a, b) => a.ts - b.ts);
    }
}

export function displayName(userId: string): string {
    const m = /^@([^:]+)/.exec(userId);
    return m ? m[1] : userId;
}

export const SYSTEM_PROMPT =
    "You are a helpful assistant taking part in a Matrix group chat. " +
    "You are given the recent conversation and a request from one participant. " +
    "Answer the request directly and concisely, in the language of the request unless it asks for another. " +
    "Use the conversation as context; do not invent messages that are not in it.";

export interface ChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

/**
 * The newest lines before `beforeEventId`, oldest first, bounded by count and by
 * characters (the small models have a 4k-token window; ~4 chars per token).
 */
export function contextLines(all: Line[], beforeEventId: string | null, maxLines: number, maxChars: number): Line[] {
    let end = all.length;
    if (beforeEventId) {
        const i = all.findIndex((l) => l.eventId === beforeEventId);
        if (i !== -1) end = i;
    }
    const out: Line[] = [];
    let chars = 0;
    for (let i = end - 1; i >= 0 && out.length < maxLines; i--) {
        const len = all[i].body.length + 40;
        if (chars + len > maxChars) {
            // A long newest message (a pasted article) is the point of the request:
            // keep its beginning rather than dropping it and leaving the model blind.
            const room = maxChars - chars - 40;
            if (out.length === 0 && room >= 200) out.push({ ...all[i], body: truncate(all[i].body, room).text });
            break;
        }
        chars += len;
        out.push(all[i]);
    }
    return out.reverse();
}

export function formatTranscript(lines: Line[], prefix: string): string {
    return lines
        .map((l) => {
            const who = l.fromModel ? "assistant" : displayName(l.sender);
            // A bare "!ai" request carries no information beyond its question.
            const q = l.fromModel ? null : parseTrigger(l.body, prefix);
            return `${who}: ${q !== null && q !== "" ? q : l.body}`;
        })
        .join("\n");
}

/** The message a request works on: the one replied to, or text given inline (from: null). */
export interface Subject {
    from: string | null;
    body: string;
}

/** Context lines after the requester's own last message (for "catch me up"). */
export function sinceMine(context: Line[], sender: string): Line[] {
    for (let i = context.length - 1; i >= 0; i--) if (context[i].sender === sender && !context[i].fromModel) return context.slice(i + 1);
    return context;
}

/**
 * System prompt plus one user message: the conversation (unless `context` is
 * null), the subject if any, and the request last. prefillRounds relies on the
 * request starting with "\n\nRequest from ".
 */
export function buildMessages(
    context: Line[] | null,
    request: { sender: string; question: string; subject?: Subject },
    prefix: string,
    systemPrompt = SYSTEM_PROMPT,
): ChatMessage[] {
    const question = request.question || "Summarise the conversation so far.";
    const parts: string[] = [];
    if (context) {
        const transcript = context.length ? formatTranscript(context, prefix) : "(no earlier messages)";
        parts.push(`Recent conversation:\n<conversation>\n${transcript}\n</conversation>`);
    }
    if (request.subject) {
        const label = request.subject.from ? `The message in question, from ${request.subject.from}:` : "The text:";
        parts.push(`${label}\n<message>\n${request.subject.body}\n</message>`);
    }
    parts.push(`Request from ${displayName(request.sender)}: ${question}`);
    return [
        { role: "system", content: systemPrompt },
        { role: "user", content: parts.join("\n\n") },
    ];
}

/** Cuts text to `max` characters, saying so, so the model knows it saw only part. */
export function truncate(text: string, max: number): { text: string; truncated: boolean } {
    if (text.length <= max) return { text, truncated: false };
    return { text: `${text.slice(0, Math.max(0, max - 16)).trimEnd()}\n[…truncated]`, truncated: true };
}

export interface Prompt {
    messages: ChatMessage[];
    /** Lines of room history included. */
    context: number;
    /** The request itself was cut to fit. */
    truncated: boolean;
}

/**
 * The whole prompt within `budgetChars`: the request first (at most 60% of the
 * budget, so a pasted article still leaves room for the conversation), then as
 * much recent history as fits in the rest.
 */
export function buildPrompt(
    all: Line[],
    request: {
        sender: string;
        question: string;
        triggerEventId: string | null;
        subject?: Subject;
        /** "none" leaves the conversation out; "since-mine" keeps what came after the requester's last message. */
        scope?: "recent" | "since-mine" | "none";
    },
    opts: { prefix: string; maxLines: number; budgetChars: number },
): Prompt {
    // The request and its subject share 60% of the budget; the conversation gets the rest.
    const big = Math.floor(opts.budgetChars * 0.6);
    const q = truncate(request.question, big);
    const s = request.subject ? truncate(request.subject.body, Math.max(200, big - q.text.length)) : null;
    const subject = request.subject && s ? { from: request.subject.from, body: s.text } : undefined;
    const scope = request.scope ?? "recent";
    let context: Line[] | null = null;
    if (scope !== "none") {
        const left = opts.budgetChars - q.text.length - (s?.text.length ?? 0) - SYSTEM_PROMPT.length;
        context = left > 200 ? contextLines(all, request.triggerEventId, opts.maxLines, left) : [];
        if (scope === "since-mine") context = sinceMine(context, request.sender);
    }
    return {
        messages: buildMessages(context, { sender: request.sender, question: q.text, subject }, opts.prefix),
        context: context?.length ?? 0,
        truncated: q.truncated || !!s?.truncated,
    };
}

/** Reasoning models (Qwen3) wrap their scratchpad in <think>; it does not belong in the room. */
export function stripThinking(text: string): string {
    return text
        .replace(/<think>[\s\S]*?<\/think>/g, "")
        .replace(/<think>[\s\S]*$/, "")
        .trim();
}

/** What an answer cost, carried in the event so anyone can see it. */
export interface AnswerStats {
    usage?: { promptTokens: number; completionTokens: number };
    ms?: number;
}

export function answerContent(body: string, replyTo: string, model: string, stats: AnswerStats = {}): Record<string, unknown> {
    return {
        msgtype: "m.notice",
        body,
        "m.relates_to": { "m.in_reply_to": { event_id: replyTo } },
        [MARKER]: {
            model,
            ...(stats.usage ? { prompt_tokens: stats.usage.promptTokens, completion_tokens: stats.usage.completionTokens } : {}),
            ...(stats.ms !== undefined ? { ms: stats.ms } : {}),
        },
    };
}

/** Splits text into pieces of at most `max` characters, preferring line and word breaks. */
export function splitText(text: string, max: number): string[] {
    const parts: string[] = [];
    let rest = text;
    while (rest.length > max) {
        let cut = rest.lastIndexOf("\n", max);
        if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
        if (cut < max * 0.5) cut = max;
        parts.push(rest.slice(0, cut).trimEnd());
        rest = rest.slice(cut).trimStart();
    }
    if (rest) parts.push(rest);
    return parts;
}

export const ACK = "OK";

/**
 * Turns one long prompt into rounds, so that no single prefill pass exceeds
 * `chunkChars`. Every round but the last carries one part and asks for a bare
 * "OK"; the engine keeps its KV cache across rounds, so each round processes only
 * its own part. Returns the user messages in order; the caller interleaves the
 * model's acknowledgements.
 */
export function prefillRounds(messages: ChatMessage[], chunkChars: number): { head: ChatMessage[]; rounds: string[] } {
    const last = messages[messages.length - 1];
    const head = messages.slice(0, -1);
    if (!last || last.role !== "user" || last.content.length <= chunkChars) return { head, rounds: last ? [last.content] : [] };
    // The request goes last and on its own: after a run of "reply only with OK"
    // turns a small model will happily answer "OK" again if the request is buried
    // in the last part.
    const at = last.content.lastIndexOf("\n\nRequest from ");
    let material = at === -1 ? last.content : last.content.slice(0, at);
    let request = at === -1 ? "" : last.content.slice(at + 2);
    // A pasted article is the request itself; then it is material too, read in
    // parts, and the last round only points at it.
    if (request.length > chunkChars / 2) {
        material = `${material}\n\n${request}`;
        request = 'The request is at the end of the material, starting with "Request from". Carry it out now.';
    }
    // Leave room for the framing text around each part.
    const parts = splitText(material, Math.max(100, chunkChars - 120));
    const k = parts.length;
    const rounds = parts.map(
        (part, i) => `Part ${i + 1} of ${k} of the material. Do not answer yet; reply only with "${ACK}".\n\n${part}`,
    );
    rounds.push(
        `That was all ${k} parts of the material. Now stop acknowledging and answer properly, using all of it.\n\n` +
            (request || "Summarise the material."),
    );
    return { head, rounds };
}
