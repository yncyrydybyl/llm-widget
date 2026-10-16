/*
 * Main-thread side of the helper models: one worker for embeddings and speech
 * recognition (ml.worker.ts), one for speech output (tts.worker.ts), and text
 * extraction from PDFs and images. Everything loads on first use.
 */
import type { MlRequest, MlResponse } from "./ml.worker";
import type { TtsRequest, TtsResponse } from "./tts.worker";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

/** Where scripts/vendor.mjs put the WASM runtimes, as an absolute URL. */
export const VENDOR = new URL("vendor/", window.location.href).href;

export type Progress = (text: string) => void;

/** Omit that keeps a union a union. */
type Body<R> = R extends unknown ? Omit<R, "id"> : never;

/** Promise-per-request over a worker that answers `{id, ok, result|error}` and may send `{id, progress}`. */
class Rpc<Req extends { id: number }, Res extends { id: number }> {
    private worker: Worker | null = null;
    private next = 1;
    private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; progress?: Progress }>();

    constructor(
        private create: () => Worker,
        private init?: Body<Req>,
    ) {}

    call<T>(req: Body<Req>, progress?: Progress, transfer: Transferable[] = []): Promise<T> {
        if (!this.worker) {
            this.worker = this.create();
            this.worker.onmessage = (ev: MessageEvent<Res>) => this.receive(ev.data);
            this.worker.onerror = (ev) => {
                for (const w of this.waiting.values()) w.reject(new Error(ev.message || "worker failed"));
                this.waiting.clear();
                this.worker = null;
            };
            if (this.init) void this.call(this.init);
        }
        const id = this.next++;
        return new Promise<T>((resolve, reject) => {
            this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, progress });
            this.worker!.postMessage({ ...req, id }, transfer);
        });
    }

    private receive(res: Res): void {
        const w = this.waiting.get(res.id);
        if (!w) return;
        const r = res as unknown as { ok?: boolean; result?: unknown; error?: string; progress?: { file: string; loaded: number; total: number } };
        if (r.progress) {
            const { file, loaded, total } = r.progress;
            w.progress?.(total ? `Downloading ${file.split("/").pop()}: ${Math.round((loaded / total) * 100)}%` : `Downloading ${file}`);
            return;
        }
        this.waiting.delete(res.id);
        if (r.ok) w.resolve(r.result);
        else w.reject(new Error(r.error));
    }
}

const ml = new Rpc<MlRequest, MlResponse>(() => new Worker(new URL("./ml.worker.ts", import.meta.url), { type: "module" }), { op: "init", vendor: VENDOR });
const tts = new Rpc<TtsRequest, TtsResponse>(() => new Worker(new URL("./tts.worker.ts", import.meta.url), { type: "module" }), { op: "init", vendor: VENDOR });

export function embed(texts: string[], kind: "query" | "passage", progress?: Progress): Promise<number[][]> {
    return ml.call<number[][]>({ op: "embed", texts, kind }, progress);
}

export interface Recogniser {
    id: string;
    label: string;
    model: string;
    device: "wasm" | "webgpu";
}

export const RECOGNISERS: Recogniser[] = [
    { id: "base", label: "Whisper base (CPU, 0.1 GB, rough German)", model: "onnx-community/whisper-base", device: "wasm" },
    { id: "small", label: "Whisper small (CPU, 0.3 GB)", model: "onnx-community/whisper-small", device: "wasm" },
    { id: "turbo", label: "Whisper large v3 turbo (GPU, 1 GB, best)", model: "onnx-community/whisper-large-v3-turbo", device: "webgpu" },
];

/** Decodes any audio the browser can play and resamples it to 16 kHz mono, as Whisper expects. */
export async function decodeAudio(blob: Blob): Promise<Float32Array> {
    const bytes = await blob.arrayBuffer();
    const ctx = new OfflineAudioContext(1, 1, 16_000);
    const decoded = await ctx.decodeAudioData(bytes);
    const render = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16_000), 16_000);
    const src = render.createBufferSource();
    src.buffer = decoded;
    src.connect(render.destination);
    src.start();
    return (await render.startRendering()).getChannelData(0);
}

/** "german" or "english" by common function words, or undefined when unclear. */
export function guessLanguage(text: string): "german" | "english" | undefined {
    const de = (text.match(/\b(der|die|das|und|ist|nicht|ich|wir|sie|ein|eine|mit|für|auf|zu|es)\b/gi) ?? []).length;
    const en = (text.match(/\b(the|and|is|not|we|you|they|a|an|with|for|on|of|to|it)\b/gi) ?? []).length;
    if (de + en < 5) return undefined;
    return de > en ? "german" : "english";
}

/**
 * Speech to text. `language` (Whisper's name, e.g. "german") avoids misdetection:
 * the small models guess the language from the first seconds and then happily
 * translate a German message into English nonsense.
 */
export async function transcribe(blob: Blob, rec: Recogniser, progress?: Progress, language?: string): Promise<string> {
    progress?.("Decoding audio…");
    const audio = await decodeAudio(blob);
    progress?.(`Transcribing ${Math.round(audio.length / 16_000)} s of audio…`);
    return ml.call<string>({ op: "transcribe", audio, model: rec.model, device: rec.device, language }, progress, [audio.buffer]);
}

export interface Voice {
    id: string;
    label: string;
    lang: "de" | "en";
}

export const VOICES: Voice[] = [
    { id: "de_DE-thorsten-medium", label: "German: Thorsten", lang: "de" },
    { id: "de_DE-kerstin-low", label: "German: Kerstin", lang: "de" },
    { id: "en_US-hfc_female-medium", label: "English: HFC female", lang: "en" },
    { id: "en_GB-alan-medium", label: "English: Alan", lang: "en" },
];

/** Speech for `text` as a WAV blob. */
export function speak(text: string, voiceId: string, progress?: Progress): Promise<Blob> {
    return tts.call<Blob>({ op: "speak", text, voiceId }, progress);
}

// pdf.js and Tesseract bring their own workers; load them only when a document needs them.

export async function pdfText(blob: Blob, progress?: Progress): Promise<string> {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;
    const task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) });
    const doc = await task.promise;
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
        progress?.(`Reading page ${i} of ${doc.numPages}…`);
        const content = await (await doc.getPage(i)).getTextContent();
        const text = content.items.map((it) => ("str" in it ? it.str + (it.hasEOL ? "\n" : " ") : "")).join("");
        pages.push(text.replace(/[ \t]+/g, " ").trim());
    }
    await task.destroy();
    return pages.filter(Boolean).join("\n\n");
}

export async function ocr(blob: Blob, progress?: Progress): Promise<string> {
    const { createWorker } = await import("tesseract.js");
    const worker = await createWorker(["deu", "eng"], 1, {
        workerPath: `${VENDOR}tesseract/worker.min.js`,
        corePath: `${VENDOR}tesseract/`,
        langPath: `${VENDOR}tesseract/lang`,
        // A blob: worker would be blocked by the CSP (worker-src 'self').
        workerBlobURL: false,
        logger: (m: { status: string; progress: number }) => progress?.(`${m.status} ${Math.round(m.progress * 100)}%`),
    });
    try {
        const { data } = await worker.recognize(blob);
        return data.text.trim();
    } finally {
        await worker.terminate();
    }
}
