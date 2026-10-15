import { describe, expect, it } from "vitest";
import type { IRoomEvent } from "matrix-widget-api";
import {
    MARKER,
    Transcript,
    answerContent,
    buildMessages,
    buildPrompt,
    prefillRounds,
    splitText,
    truncate,
    contextLines,
    parseTrigger,
    stripReplyFallback,
    stripThinking,
    toLine,
    type Line,
} from "./room";

const ev = (id: string, content: Record<string, unknown>, ts = 0, sender = "@alice:example.org"): IRoomEvent =>
    ({ type: "m.room.message", event_id: id, sender, content, origin_server_ts: ts, room_id: "!r", unsigned: {} }) as IRoomEvent;

const line = (id: string, body: string, ts: number, extra: Partial<Line> = {}): Line => ({
    eventId: id,
    sender: "@alice:example.org",
    body,
    ts,
    fromModel: false,
    ...extra,
});

describe("parseTrigger", () => {
    it("extracts the question after the prefix", () => {
        expect(parseTrigger("!ai what now?", "!ai")).toBe("what now?");
        expect(parseTrigger("  !AI: summarise", "!ai")).toBe("summarise");
        expect(parseTrigger("!ai", "!ai")).toBe("");
    });
    it("ignores other messages and longer words", () => {
        expect(parseTrigger("hello !ai", "!ai")).toBeNull();
        expect(parseTrigger("!aix", "!ai")).toBeNull();
        expect(parseTrigger("!ai x", "")).toBeNull();
    });
});

describe("toLine", () => {
    it("reads text and marks our notices as model output", () => {
        expect(toLine(ev("$1", { msgtype: "m.text", body: "hi" }))?.fromModel).toBe(false);
        const a = toLine(ev("$2", answerContent("ok", "$1", "m")))!;
        expect(a.fromModel).toBe(true);
        expect(a.inReplyTo).toBe("$1");
    });
    it("skips edits, other msgtypes and foreign notices count as plain lines", () => {
        expect(toLine(ev("$1", { msgtype: "m.image", body: "x.png" }))).toBeNull();
        expect(toLine(ev("$1", { msgtype: "m.text", body: "* x", "m.relates_to": { rel_type: "m.replace" } }))).toBeNull();
        expect(toLine(ev("$1", { msgtype: "m.notice", body: "bot" }))?.fromModel).toBe(false);
    });
    it("strips the rich-reply fallback", () => {
        expect(stripReplyFallback("> <@bob:x> earlier\n> more\n\nmy answer")).toBe("my answer");
        expect(stripReplyFallback("plain")).toBe("plain");
    });
});

describe("Transcript", () => {
    it("de-duplicates, orders by time and knows what was answered", () => {
        const t = new Transcript();
        expect(t.add(line("$b", "two", 2))).toBe(true);
        expect(t.add(line("$a", "one", 1))).toBe(true);
        expect(t.add(line("$a", "one", 1))).toBe(false);
        expect(t.lines().map((l) => l.eventId)).toEqual(["$a", "$b"]);
        expect(t.answered("$a")).toBe(false);
        t.add(line("$c", "answer", 3, { fromModel: true, inReplyTo: "$a" }));
        expect(t.answered("$a")).toBe(true);
    });
});

describe("prompt", () => {
    const all = [line("$1", "we meet at 3", 1), line("$2", "ok, room B", 2), line("$3", "!ai when and where?", 3)];

    it("takes the lines before the request, bounded by count", () => {
        expect(contextLines(all, "$3", 10, 10_000).map((l) => l.eventId)).toEqual(["$1", "$2"]);
        expect(contextLines(all, "$3", 1, 10_000).map((l) => l.eventId)).toEqual(["$2"]);
        expect(contextLines(all, null, 10, 10_000)).toHaveLength(3);
    });

    it("bounds by characters", () => {
        expect(contextLines(all, "$3", 10, 60)).toHaveLength(1);
        expect(contextLines(all, "$3", 10, 1)).toHaveLength(0);
    });

    it("fits a pasted article and still keeps recent history", () => {
        const article = "word ".repeat(5000);
        const p = buildPrompt(all, { sender: "@bob:x", question: article, triggerEventId: "$3" }, { prefix: "!ai", maxLines: 30, budgetChars: 9000 });
        const size = p.messages.reduce((n, m) => n + m.content.length, 0);
        expect(p.truncated).toBe(true);
        expect(size).toBeLessThan(9500);
        expect(p.context).toBe(2);
        expect(p.messages[1].content).toContain("[…truncated]");
    });

    it("keeps the start of an oversize newest message instead of dropping it", () => {
        const long = [line("$1", "old", 1), line("$2", "x ".repeat(5000), 2)];
        const c = contextLines(long, null, 30, 1000);
        expect(c).toHaveLength(1);
        expect(c[0].body).toContain("[…truncated]");
        expect(c[0].body.length).toBeLessThanOrEqual(1000);
    });

    it("leaves short requests alone", () => {
        const p = buildPrompt(all, { sender: "@bob:x", question: "when?", triggerEventId: "$3" }, { prefix: "!ai", maxLines: 30, budgetChars: 9000 });
        expect(p.truncated).toBe(false);
        expect(truncate("abc", 10)).toEqual({ text: "abc", truncated: false });
    });

    it("builds a system + user message with the transcript", () => {
        const m = buildMessages(contextLines(all, "$3", 10, 10_000), { sender: "@bob:x", question: "when?" }, "!ai");
        expect(m[0].role).toBe("system");
        expect(m[1].content).toContain("alice: we meet at 3");
        expect(m[1].content).toContain("Request from bob: when?");
    });

    it("defaults an empty question to a summary", () => {
        expect(buildMessages([], { sender: "@bob:x", question: "" }, "!ai")[1].content).toContain("Summarise");
    });
});

describe("answers", () => {
    it("strips reasoning blocks", () => {
        expect(stripThinking("<think>hmm</think>\nThe answer")).toBe("The answer");
        expect(stripThinking("<think>unfinished")).toBe("");
    });
    it("carries the marker and reply relation", () => {
        const c = answerContent("hi", "$1", "Qwen");
        expect(c.msgtype).toBe("m.notice");
        expect(c[MARKER]).toEqual({ model: "Qwen" });
    });
});

describe("prefill rounds", () => {
    it("splits a long request too and points at it in the last round", () => {
        const text = "Recent conversation: hi\n\nRequest from bob: " + "article ".repeat(800);
        const r = prefillRounds([{ role: "system", content: "s" }, { role: "user", content: text }], 1000);
        for (const round of r.rounds) expect(round.length).toBeLessThanOrEqual(1100);
        expect(r.rounds.slice(0, -1).join("")).toContain("Request from bob");
        expect(r.rounds.at(-1)).toContain("Carry it out now");
    });

    it("splits at word boundaries within the limit", () => {
        const parts = splitText("aaa bbb ccc ddd", 8);
        expect(parts).toEqual(["aaa bbb", "ccc ddd"]);
        expect(splitText("short", 100)).toEqual(["short"]);
    });

    it("leaves a short prompt as one round", () => {
        const r = prefillRounds([{ role: "system", content: "s" }, { role: "user", content: "hi" }], 1000);
        expect(r.head).toHaveLength(1);
        expect(r.rounds).toEqual(["hi"]);
    });

    it("feeds a long prompt in parts, the request last", () => {
        const text = "word ".repeat(1000) + "\n\nRequest from bob: summarise";
        const r = prefillRounds([{ role: "system", content: "s" }, { role: "user", content: text }], 1000);
        expect(r.rounds.length).toBeGreaterThan(4);
        for (const round of r.rounds) expect(round.length).toBeLessThanOrEqual(1100);
        expect(r.rounds[0]).toContain('reply only with "OK"');
        expect(r.rounds.at(-1)).toMatch(/^That was all \d+ parts/);
        expect(r.rounds.at(-1)).toContain("Request from bob: summarise");
        expect(r.rounds.slice(0, -1).join("")).not.toContain("Request from bob");
    });
});
