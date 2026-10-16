import { describe, expect, it } from "vitest";
import { COMMANDS, helpText, languageName, plan } from "./commands";
import { buildPrompt, type Line } from "./room";

const line = (id: string, body: string, ts: number, sender = "@alice:x", extra: Partial<Line> = {}): Line => ({
    eventId: id,
    sender,
    body,
    ts,
    fromModel: false,
    ...extra,
});

const all = [
    line("$1", "Wir treffen uns um 3", 1, "@bob:x"),
    line("$2", "ok, Raum B", 2, "@carol:x"),
    line("$3", "!ai tr en", 3),
];

describe("plan", () => {
    it("keeps free questions free, with the replied-to message as subject", () => {
        const trigger = line("$9", "!ai what does this mean?", 9, "@alice:x", { inReplyTo: "$1" });
        const p = plan("what does this mean?", [...all, trigger], trigger, "!ai");
        expect(p).toMatchObject({ command: null, instruction: "what does this mean?", scope: "recent", target: { sender: "bob", body: "Wir treffen uns um 3" } });
    });

    it("translates the previous message when nothing else is given", () => {
        const p = plan("tr en", all, all[2], "!ai");
        expect(p.instruction).toContain("into English");
        expect(p.scope).toBe("none");
        expect(p.target?.body).toBe("ok, Raum B");
    });

    it("prefers the replied-to message, and inline text over both", () => {
        const reply = line("$4", "!ai tr fr", 4, "@alice:x", { inReplyTo: "$1" });
        expect(plan("tr fr", [...all, reply], reply, "!ai").target?.sender).toBe("bob");
        const inline = plan("tr German good morning all", all, null, "!ai");
        expect(inline.instruction).toContain("into German");
        expect(inline.text).toBe("good morning all");
        expect(inline.target).toBeUndefined();
    });

    it("skips earlier requests when looking for the previous message", () => {
        const withRequests = [...all, line("$4", "!ai fix", 4)];
        expect(plan("fix", withRequests, withRequests[3], "!ai").target?.body).toBe("ok, Raum B");
    });

    it("answers usage errors and help without the model", () => {
        expect(plan("tr", all, null, "!ai").fixed).toContain("which language");
        expect(plan("rewrite fancy", all, null, "!ai").fixed).toContain("Styles");
        expect(plan("ideas", all, null, "!ai").fixed).toBeDefined();
        expect(plan("fix", [], null, "!ai").fixed).toContain("Nothing to work on");
        const help = plan("help", all, null, "!ai").fixed!;
        for (const c of COMMANDS) expect(help).toContain(`!ai ${c.usage}`);
    });

    it("reads options: summary length, catch-up scope, aliases, case", () => {
        expect(plan("sum 10", all, null, "!ai").maxLines).toBe(10);
        expect(plan("SUM", all, null, "!ai").command).toBe("sum");
        expect(plan("zusammenfassung", all, null, "!ai").command).toBe("sum");
        expect(plan("when do we meet?", all, null, "!ai").command).toBeNull();
        expect(plan("sum what happened today?", all, null, "!ai").command).toBeNull();
        expect(plan("catchup", all, null, "!ai")).toMatchObject({ scope: "since-mine", maxLines: 50 });
        expect(plan("reply politely decline", all, null, "!ai").instruction).toContain("politely decline");
        expect(plan("summary the budget talk", all, null, "!ai").instruction).toMatch(/Focus on: the budget talk\.$/);
        expect(plan("sum 10", all, null, "!ai").instruction).not.toContain("Focus");
    });

    it("knows language codes and names", () => {
        expect(languageName("de")).toBe("German");
        expect(languageName("klingon")).toBe("Klingon");
        expect(languageName("x")).toBeNull();
        expect(helpText("!ki")).toContain("!ki tldr");
    });
});

describe("prompt from a plan", () => {
    it("leaves the conversation out for text commands", () => {
        const p = plan("fix their is a problem", all, null, "!ai");
        const m = buildPrompt(all, { sender: "@alice:x", question: p.instruction, triggerEventId: null, subject: { from: null, body: p.text! }, scope: p.scope }, { prefix: "!ai", maxLines: 30, budgetChars: 9000 });
        expect(m.context).toBe(0);
        expect(m.messages[1].content).not.toContain("<conversation>");
        expect(m.messages[1].content).toMatch(/^The text:\n<message>\ntheir is a problem\n<\/message>\n\nRequest from alice: Correct/);
    });

    it("catches up from the requester's last message", () => {
        const room = [line("$1", "old stuff", 1, "@bob:x"), line("$2", "bye", 2, "@alice:x"), line("$3", "news", 3, "@bob:x"), line("$4", "!ai catchup", 4)];
        const m = buildPrompt(room, { sender: "@alice:x", question: "catch me up", triggerEventId: "$4", scope: "since-mine" }, { prefix: "!ai", maxLines: 50, budgetChars: 9000 });
        expect(m.context).toBe(1);
        expect(m.messages[1].content).toContain("bob: news");
        expect(m.messages[1].content).not.toContain("old stuff");
    });
});
