/*
 * Pure room logic: turning timeline events into a transcript, deciding which
 * messages are requests for the model, and building the prompt. No widget API and
 * no DOM here, so all of it is unit-tested.
 */
import type { IRoomEvent } from "matrix-widget-api";

/** Marks our own answers so they are recognised as model output, also in other widgets. */
export const MARKER = "de.minagawa.llm_widget";

export interface Line {
    eventId: string;
    sender: string;
    body: string;
    ts: number;
    /** A notice sent by this widget (any instance, any user). */
    fromModel: boolean;
    /** For model answers: the event they reply to. */
    inReplyTo?: string;
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
    if (c.msgtype !== "m.text" && c.msgtype !== "m.notice") return null;
    if (typeof c.body !== "string") return null;
    // Edits arrive as new events; keeping only originals is good enough here.
    if (c["m.relates_to"]?.rel_type === "m.replace") return null;
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
    "Answer the request directly and concisely, in the language of the request. " +
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
        if (chars + len > maxChars) break;
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

export function buildMessages(
    context: Line[],
    request: { sender: string; question: string },
    prefix: string,
    systemPrompt = SYSTEM_PROMPT,
): ChatMessage[] {
    const question = request.question || "Summarise the conversation so far.";
    const transcript = context.length ? formatTranscript(context, prefix) : "(no earlier messages)";
    return [
        { role: "system", content: systemPrompt },
        {
            role: "user",
            content:
                `Recent conversation:\n<conversation>\n${transcript}\n</conversation>\n\n` +
                `Request from ${displayName(request.sender)}: ${question}`,
        },
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
    request: { sender: string; question: string; triggerEventId: string | null },
    opts: { prefix: string; maxLines: number; budgetChars: number },
): Prompt {
    const q = truncate(request.question, Math.floor(opts.budgetChars * 0.6));
    const left = opts.budgetChars - q.text.length - SYSTEM_PROMPT.length;
    const context = left > 200 ? contextLines(all, request.triggerEventId, opts.maxLines, left) : [];
    return {
        messages: buildMessages(context, { sender: request.sender, question: q.text }, opts.prefix),
        context: context.length,
        truncated: q.truncated,
    };
}

/** Reasoning models (Qwen3) wrap their scratchpad in <think>; it does not belong in the room. */
export function stripThinking(text: string): string {
    return text
        .replace(/<think>[\s\S]*?<\/think>/g, "")
        .replace(/<think>[\s\S]*$/, "")
        .trim();
}

export function answerContent(body: string, replyTo: string, model: string): Record<string, unknown> {
    return {
        msgtype: "m.notice",
        body,
        "m.relates_to": { "m.in_reply_to": { event_id: replyTo } },
        [MARKER]: { model },
    };
}
