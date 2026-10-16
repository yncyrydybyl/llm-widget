/*
 * Attachments in the room: voice messages, audio, images and files. The widget
 * downloads them through the client (MSC4039 download_file) and, in an encrypted
 * room, decrypts them itself with the per-file key from the event, following the
 * spec's EncryptedFile scheme: SHA-256 over the ciphertext, then AES-CTR-256.
 */
import type { WidgetApi } from "matrix-widget-api";

export type MediaKind = "audio" | "image" | "file";

export interface EncryptedFile {
    url: string;
    key: { k: string; alg?: string };
    iv: string;
    hashes: { sha256: string };
}

export interface Media {
    kind: MediaKind;
    /** True for MSC3245 voice messages (recorded in the client). */
    voice: boolean;
    name: string;
    mimetype: string;
    size?: number;
    /** Duration in ms, for audio. */
    duration?: number;
    /** Unencrypted media. */
    url?: string;
    /** Encrypted media: where it is and how to decrypt it. */
    file?: EncryptedFile;
}

interface MediaContent {
    msgtype?: string;
    body?: unknown;
    filename?: unknown;
    url?: unknown;
    file?: Partial<EncryptedFile>;
    info?: { mimetype?: unknown; size?: unknown; duration?: unknown };
    "org.matrix.msc3245.voice"?: unknown;
    "org.matrix.msc1767.audio"?: { duration?: unknown };
}

const KINDS: Record<string, MediaKind> = { "m.audio": "audio", "m.image": "image", "m.file": "file" };

export function toMedia(content: unknown): Media | null {
    const c = (content ?? {}) as MediaContent;
    const kind = KINDS[c.msgtype ?? ""];
    if (!kind) return null;
    const file = c.file;
    const encrypted =
        file && typeof file.url === "string" && typeof file.iv === "string" && typeof file.key?.k === "string" && typeof file.hashes?.sha256 === "string"
            ? (file as EncryptedFile)
            : undefined;
    const url = typeof c.url === "string" ? c.url : undefined;
    if (!encrypted && !url) return null;
    const num = (v: unknown): number | undefined => (typeof v === "number" && v >= 0 ? v : undefined);
    const name = typeof c.filename === "string" ? c.filename : typeof c.body === "string" ? c.body : kind;
    return {
        kind,
        voice: "org.matrix.msc3245.voice" in c,
        name,
        mimetype: typeof c.info?.mimetype === "string" ? c.info.mimetype : "",
        size: num(c.info?.size),
        duration: num(c.info?.duration) ?? num(c["org.matrix.msc1767.audio"]?.duration),
        url,
        file: encrypted,
    };
}

export function isPdf(m: Media): boolean {
    return m.mimetype === "application/pdf" || /\.pdf$/i.test(m.name);
}

export function isText(m: Media): boolean {
    return m.mimetype.startsWith("text/") || /\.(txt|md|csv|json|log)$/i.test(m.name);
}

/** What the model can do with it, or null when it cannot read it at all. */
export function readable(m: Media): "transcribe" | "ocr" | "pdf" | "text" | null {
    if (m.kind === "audio") return "transcribe";
    if (m.kind === "image") return "ocr";
    if (isPdf(m)) return "pdf";
    if (isText(m)) return "text";
    return null;
}

/** How the attachment appears in the transcript the model sees. */
export function describe(m: Media): string {
    const secs = m.duration ? `, ${Math.round(m.duration / 1000)} s` : "";
    if (m.kind === "audio") return m.voice ? `[voice message${secs}]` : `[audio: ${m.name}${secs}]`;
    if (m.kind === "image") return `[image: ${m.name}]`;
    return `[file: ${m.name}]`;
}

function decodeBase64(input: string): Uint8Array<ArrayBuffer> {
    const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "="));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

function encodeBase64(bytes: Uint8Array): string {
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/=+$/, "");
}

/** Checks the hash first (the spec requires it: it is what catches swapped bytes), then decrypts. */
export async function decrypt(ciphertext: ArrayBuffer, f: EncryptedFile): Promise<ArrayBuffer> {
    const hash = encodeBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", ciphertext)));
    if (hash !== f.hashes.sha256.replace(/=+$/, "")) throw new Error("The attachment does not match the hash in its event.");
    const key = await crypto.subtle.importKey("raw", decodeBase64(f.key.k), { name: "AES-CTR" }, false, ["decrypt"]);
    return crypto.subtle.decrypt({ name: "AES-CTR", counter: decodeBase64(f.iv), length: 64 }, key, ciphertext);
}

/** Largest attachment the widget downloads: models read text, not archives. */
export const MAX_DOWNLOAD = 50 * 1024 * 1024;

export async function download(api: WidgetApi, m: Media): Promise<Blob> {
    if (m.size && m.size > MAX_DOWNLOAD) throw new Error(`${m.name} is too large (${Math.round(m.size / 1e6)} MB).`);
    const mxc = m.file?.url ?? m.url!;
    const { file } = await api.downloadFile(mxc);
    const raw = file instanceof Blob ? await file.arrayBuffer() : (file as ArrayBuffer);
    const bytes = m.file ? await decrypt(raw, m.file) : raw;
    return new Blob([bytes], { type: m.mimetype || "application/octet-stream" });
}
