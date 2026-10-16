/*
 * Shortcuts after the trigger: `!ai sum`, `!ai tr en`, `!ai fix`, … Each turns
 * into a fixed, specific instruction (small models follow those far better than
 * free-form requests) plus how much of the room the model needs to see.
 *
 * A request sent as a reply works on the message it replies to; commands that
 * work on a message and get neither a reply nor inline text take the message
 * just before the request.
 *
 * Pure, like room.ts.
 */
import { displayName, parseTrigger, type Line } from "./room";

/** How much of the conversation goes into the prompt. */
export type Scope = "recent" | "since-mine" | "none";

export interface Plan {
    /** The command's name; null for a free question. */
    command: string | null;
    /** What the model is asked to do, after "Request from <name>: ". */
    instruction: string;
    scope: Scope;
    /** Overrides the context size setting (`!ai sum 10`). */
    maxLines?: number;
    /** The message to work on. */
    target?: { sender: string; body: string };
    /** Text given inline to work on (`!ai fix their is a problem`). */
    text?: string;
    /** An answer that needs no model (help, usage errors). */
    fixed?: string;
}

interface Command {
    names: string[];
    usage: string;
    help: string;
    /** Works on a message: the replied-to one, inline text, or the previous one. */
    needsText?: boolean;
    scope: Scope;
    /** `args` is what follows the command name; `text` the message worked on, if any. */
    instruction: (args: string) => string | { error: string };
}

const IN_ROOM_LANGUAGE = "Write in the language the conversation is mostly written in.";

const LANGUAGES: Record<string, string> = {
    de: "German", en: "English", fr: "French", es: "Spanish", it: "Italian", nl: "Dutch", pl: "Polish",
    pt: "Portuguese", sv: "Swedish", da: "Danish", fi: "Finnish", no: "Norwegian", cs: "Czech", tr: "Turkish",
    ru: "Russian", uk: "Ukrainian", ja: "Japanese", zh: "Chinese", ko: "Korean", ar: "Arabic",
};

const STYLES: Record<string, string> = {
    polite: "more polite and friendly",
    short: "shorter, keeping every point",
    formal: "more formal",
    casual: "more casual",
    simple: "in simpler words, easy to understand",
    clear: "clearer and better structured",
};

/** "en" → "English"; full names pass through capitalised. */
export function languageName(code: string): string | null {
    const c = code.toLowerCase();
    if (LANGUAGES[c]) return LANGUAGES[c];
    if (/^[a-zäöüß]{3,}$/i.test(code)) return code[0].toUpperCase() + code.slice(1).toLowerCase();
    return null;
}

export const COMMANDS: Command[] = [
    {
        names: ["sum", "summary", "summarise", "summarize", "zusammenfassung"],
        usage: "sum [n]",
        help: "summarise the conversation (the last n messages)",
        scope: "recent",
        instruction: () => `Summarise the conversation in a few bullet points: topics, outcomes, and who said what where it matters. ${IN_ROOM_LANGUAGE}`,
    },
    {
        names: ["catchup"],
        usage: "catchup",
        help: "what happened since your last message",
        scope: "since-mine",
        instruction: () =>
            `I was away. Tell me briefly what happened in this part of the conversation and whether anything needs my attention or answer. ${IN_ROOM_LANGUAGE}`,
    },
    {
        names: ["decisions"],
        usage: "decisions",
        help: "list the decisions taken",
        scope: "recent",
        instruction: () =>
            `List the decisions the participants agreed on, one per line, with who decided. Only real decisions; if there are none, say so. ${IN_ROOM_LANGUAGE}`,
    },
    {
        names: ["todo", "todos", "aufgaben"],
        usage: "todo",
        help: "action items with owner and due date",
        scope: "recent",
        instruction: () =>
            `Extract the action items as a checklist: "- [ ] task — owner — due date". Write "?" where the owner or date is not stated. Do not invent tasks. ${IN_ROOM_LANGUAGE}`,
    },
    {
        names: ["questions"],
        usage: "questions",
        help: "questions nobody has answered yet",
        scope: "recent",
        instruction: () =>
            `List the questions asked in the conversation that have not been answered yet, with who asked them. If all were answered, say so. ${IN_ROOM_LANGUAGE}`,
    },
    {
        names: ["notes", "minutes", "protokoll"],
        usage: "notes",
        help: "meeting notes: topics, decisions, next steps",
        scope: "recent",
        instruction: () => `Write meeting notes for this conversation with the headings Topics, Decisions and Next steps. Be concise. ${IN_ROOM_LANGUAGE}`,
    },
    {
        names: ["schedule", "termin"],
        usage: "schedule",
        help: "find a date that suits everyone",
        scope: "recent",
        instruction: () =>
            `Collect the dates and times each participant said they can or cannot do, then propose the option that suits most people. Say who cannot make it. ${IN_ROOM_LANGUAGE}`,
    },
    {
        names: ["mood"],
        usage: "mood",
        help: "how the discussion feels; any tension",
        scope: "recent",
        instruction: () =>
            `Describe the tone of the conversation in two or three sentences. Point out tension or misunderstandings, and suggest how to calm things if needed. Be neutral and kind. ${IN_ROOM_LANGUAGE}`,
    },
    {
        names: ["email"],
        usage: "email [to whom]",
        help: "turn the discussion into an email",
        scope: "recent",
        instruction: (to) => `Write an email${to ? ` to ${to}` : ""} that sums up this discussion and its outcome. Subject line first. ${IN_ROOM_LANGUAGE}`,
    },
    {
        names: ["announce", "announcement"],
        usage: "announce",
        help: "an announcement of what was decided",
        scope: "recent",
        instruction: () => `Write a short announcement of what was decided, for people who were not in this conversation. ${IN_ROOM_LANGUAGE}`,
    },
    {
        names: ["ideas", "brainstorm"],
        usage: "ideas <topic>",
        help: "brainstorm ideas",
        scope: "recent",
        instruction: (topic) =>
            topic
                ? `Brainstorm ten varied ideas for: ${topic}. One line each. Use the conversation for context.`
                : { error: "Say what to brainstorm about, e.g. `ideas team event in May`." },
    },
    {
        names: ["tldr"],
        usage: "tldr",
        help: "a two-sentence summary of a (long) message",
        needsText: true,
        scope: "none",
        instruction: () => "Summarise this message in at most two sentences, in its own language.",
    },
    {
        names: ["tr", "translate", "übersetze"],
        usage: "tr <language> [text]",
        help: "translate a message, e.g. tr en or tr German",
        needsText: true,
        scope: "none",
        instruction: (lang) => {
            const name = languageName(lang);
            if (!name) return { error: "Say which language, e.g. `tr en` or `tr German`." };
            return `Translate this text into ${name}. Reply with the translation only.`;
        },
    },
    {
        names: ["fix", "korrigiere"],
        usage: "fix [text]",
        help: "correct spelling and grammar",
        needsText: true,
        scope: "none",
        instruction: () =>
            "Correct the spelling and grammar of this text, in its own language, changing as little as possible. Reply with the corrected text only.",
    },
    {
        names: ["rewrite"],
        usage: `rewrite <${Object.keys(STYLES).join("|")}> [text]`,
        help: "rewrite a message in another style",
        needsText: true,
        scope: "none",
        instruction: (style) => {
            const how = STYLES[style.toLowerCase()];
            if (!how) return { error: `Say how, e.g. \`rewrite polite\`. Styles: ${Object.keys(STYLES).join(", ")}.` };
            return `Rewrite this text to be ${how}, in its own language. Reply with the rewritten text only.`;
        },
    },
    {
        names: ["explain", "erkläre"],
        usage: "explain [term]",
        help: "explain a term, or the message replied to",
        scope: "recent",
        instruction: (term) =>
            term
                ? `Explain "${term}" simply, as it is meant in this conversation. In the language of the conversation.`
                : `Explain the message in question simply: what it means and any terms in it. ${IN_ROOM_LANGUAGE}`,
    },
    {
        names: ["reply", "antwort"],
        usage: "reply [how]",
        help: "draft a reply to a message",
        needsText: true,
        scope: "recent",
        instruction: (how) =>
            `Draft a reply to the message in question, as I would write it${how ? `: ${how}` : ""}. Match the language and tone of the conversation. Reply with the draft only.`,
    },
];

/** Commands whose first argument is a word (language, style) rather than part of the text. */
const WORD_ARG = new Set(["tr", "rewrite"]);

function find(name: string): Command | undefined {
    const n = name.toLowerCase();
    return COMMANDS.find((c) => c.names.includes(n));
}

export function helpText(prefix: string): string {
    return [
        `Ask me anything with ${prefix} <question>, or use a shortcut. Reply to a message to make it the one I work on.`,
        ...COMMANDS.map((c) => `${prefix} ${c.usage} — ${c.help}`),
        `${prefix} help — this list`,
    ].join("\n");
}

/** The line just before `beforeEventId` that is not itself a request. */
function previous(all: Line[], beforeEventId: string | null, prefix: string): Line | undefined {
    let end = all.length;
    if (beforeEventId) {
        const i = all.findIndex((l) => l.eventId === beforeEventId);
        if (i !== -1) end = i;
    }
    for (let i = end - 1; i >= 0; i--) if (all[i].fromModel || parseTrigger(all[i].body, prefix) === null) return all[i];
    return undefined;
}

/**
 * Turns the text after the trigger into a plan. `trigger` is the room message
 * that asked (null for a private question); `all` the transcript.
 */
export function plan(question: string, all: Line[], trigger: Line | null, prefix: string): Plan {
    const replied = trigger?.inReplyTo ? all.find((l) => l.eventId === trigger.inReplyTo) : undefined;
    const asTarget = (l: Line | undefined) => (l ? { sender: l.fromModel ? "assistant" : displayName(l.sender), body: l.body } : undefined);

    const [word = "", ...restWords] = question.split(/\s+/);
    const rest = question.slice(word.length).trim();
    if (word.toLowerCase() === "help") return { command: "help", instruction: "", scope: "none", fixed: helpText(prefix) };

    // Command names are plain words, so "when …?" or "summary of what?" may just
    // be a question: a trailing "?" after more words keeps it a free question.
    const asked = rest !== "" && question.trimEnd().endsWith("?");
    const cmd = asked ? undefined : find(word);
    if (!cmd) {
        return {
            command: null,
            instruction: question || "Summarise the conversation so far.",
            scope: "recent",
            target: asTarget(replied),
        };
    }
    const name = cmd.names[0];

    // tr/rewrite take one word first; the rest is text to work on.
    let args = rest;
    let text = "";
    if (WORD_ARG.has(name)) {
        args = restWords[0] ?? "";
        text = rest.slice(args.length).trim();
    } else if (cmd.needsText && name !== "reply") {
        text = rest;
        args = "";
    }
    const instruction = cmd.instruction(args);
    if (typeof instruction !== "string") return { command: name, instruction: "", scope: "none", fixed: instruction.error };

    const p: Plan = { command: name, instruction, scope: cmd.scope };
    const count = /^\d+$/.test(rest);
    if (name === "sum" && count) p.maxLines = Math.min(50, Math.max(1, Number(rest)));
    // Commands without arguments still take words after them as a focus: `!ai sum the budget`.
    else if (cmd.instruction.length === 0 && !cmd.needsText && rest) p.instruction += ` Focus on: ${rest}.`;
    // Catching up may span more than the usual context; the host returns at most 50.
    if (cmd.scope === "since-mine") p.maxLines = 50;
    if (text) p.text = text;
    else if (replied) p.target = asTarget(replied);
    else if (cmd.needsText) {
        const before = previous(all, trigger?.eventId ?? null, prefix);
        if (!before) return { command: name, instruction: "", scope: "none", fixed: `Nothing to work on: reply to a message with ${prefix} ${cmd.usage}.` };
        p.target = asTarget(before);
    }
    return p;
}

