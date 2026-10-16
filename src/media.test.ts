import { describe, expect, it } from "vitest";
import { decrypt, describe as describeMedia, readable, toMedia, type EncryptedFile } from "./media";
import { chunk, excerpts, topK } from "./search";
import { plan } from "./commands";
import { toLine, type Line } from "./room";

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/=+$/, "");

/** Encrypts like a Matrix client does. */
async function encrypt(plain: Uint8Array<ArrayBuffer>): Promise<{ data: ArrayBuffer; file: EncryptedFile }> {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const iv = new Uint8Array(16);
    iv.set(crypto.getRandomValues(new Uint8Array(8)));
    const key = await crypto.subtle.importKey("raw", raw, { name: "AES-CTR" }, false, ["encrypt"]);
    const data = await crypto.subtle.encrypt({ name: "AES-CTR", counter: iv, length: 64 }, key, plain);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    const k = b64(raw).replace(/\+/g, "-").replace(/\//g, "_");
    return { data, file: { url: "mxc://x/y", key: { k, alg: "A256CTR" }, iv: b64(iv), hashes: { sha256: b64(hash) } } };
}

describe("media", () => {
    it("reads voice messages, images and files from events", () => {
        const voice = toMedia({ msgtype: "m.audio", body: "Voice message", url: "mxc://a/b", info: { mimetype: "audio/ogg", duration: 12_300 }, "org.matrix.msc3245.voice": {} })!;
        expect(voice).toMatchObject({ kind: "audio", voice: true });
        expect(describeMedia(voice)).toBe("[voice message, 12 s]");
        const pdf = toMedia({ msgtype: "m.file", body: "Plan.pdf", url: "mxc://a/c", info: { mimetype: "application/pdf" } })!;
        expect(readable(pdf)).toBe("pdf");
        expect(readable(toMedia({ msgtype: "m.file", body: "a.zip", url: "mxc://a/d" })!)).toBeNull();
        expect(toMedia({ msgtype: "m.text", body: "hi" })).toBeNull();
        expect(toMedia({ msgtype: "m.image", body: "x.png" })).toBeNull();
    });

    it("turns attachments into transcript lines", () => {
        const l = toLine({ type: "m.room.message", event_id: "$1", sender: "@a:x", origin_server_ts: 1, room_id: "!r", unsigned: {}, content: { msgtype: "m.image", body: "scan.png", url: "mxc://a/b" } } as never)!;
        expect(l.body).toBe("[image: scan.png]");
        expect(l.media?.kind).toBe("image");
    });

    it("decrypts an encrypted attachment and rejects tampered bytes", async () => {
        const plain = new TextEncoder().encode("Geheimer Plan");
        const { data, file } = await encrypt(plain);
        expect(new TextDecoder().decode(await decrypt(data, file))).toBe("Geheimer Plan");
        const bad = new Uint8Array(data.slice(0));
        bad[0] ^= 1;
        await expect(decrypt(bad.buffer, file)).rejects.toThrow(/hash/);
    });

    it("plans transcribe and read only on attachments", () => {
        const voice: Line = { eventId: "$v", sender: "@bob:x", body: "[voice message]", ts: 1, fromModel: false, media: toMedia({ msgtype: "m.audio", body: "v", url: "mxc://a/v", "org.matrix.msc3245.voice": {} })! };
        const text: Line = { eventId: "$t", sender: "@bob:x", body: "hello", ts: 2, fromModel: false };
        // The last attachment, even with text after it.
        expect(plan("transcribe", [voice, text], null, "!ai")).toMatchObject({ extract: true, target: { eventId: "$v" } });
        expect(plan("transcribe", [text], null, "!ai").fixed).toContain("Reply to a voice message");
        const reply: Line = { eventId: "$r", sender: "@a:x", body: "!ai sum", ts: 3, fromModel: false, inReplyTo: "$v" };
        expect(plan("sum", [voice, text, reply], reply, "!ai")).toMatchObject({ scope: "none", target: { eventId: "$v" } });
    });
});

describe("search", () => {
    it("keeps the best scores in original order", () => {
        expect(topK([0.1, 0.9, 0.5, 0.8], 2)).toEqual([1, 3]);
        expect(topK([0.1, 0.9], 5, 0.5)).toEqual([1]);
    });

    it("builds excerpts within the budget and marks gaps", () => {
        const parts = ["intro", "budget is 5k", "weather", "budget approved"];
        expect(excerpts(parts, [0, 1, 0, 0.9], 50)).toBe("[…]\n\nbudget is 5k\n\n[…]\n\nbudget approved");
        expect(chunk("a ".repeat(1000), 300).every((c) => c.length <= 300)).toBe(true);
    });
});
