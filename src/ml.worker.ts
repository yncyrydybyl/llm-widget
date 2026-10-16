/*
 * Helper models next to the LLM, via Transformers.js: sentence embeddings for
 * finding relevant messages and document parts, and Whisper for speech. In a
 * worker so inference never blocks the page.
 *
 * Embeddings run on WASM on purpose: small, fast enough on one CPU thread, and
 * they leave the GPU to the LLM. Whisper can run on either.
 */
import { env, pipeline, type AutomaticSpeechRecognitionPipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

export type MlRequest =
    | { id: number; op: "init"; vendor: string }
    | { id: number; op: "embed"; texts: string[]; kind: "query" | "passage" }
    | { id: number; op: "transcribe"; audio: Float32Array; model: string; device: "wasm" | "webgpu"; language?: string };

export type MlResponse =
    | { id: number; ok: true; result: unknown }
    | { id: number; ok: false; error: string }
    | { id: number; progress: { file: string; loaded: number; total: number } };

export const EMBED_MODEL = "Xenova/multilingual-e5-small";

let embedder: Promise<FeatureExtractionPipeline> | null = null;
const recognisers = new Map<string, Promise<AutomaticSpeechRecognitionPipeline>>();

function progress(id: number) {
    return (p: { status?: string; file?: string; loaded?: number; total?: number }) => {
        if (p.status === "progress" && p.file) postMessage({ id, progress: { file: p.file, loaded: p.loaded ?? 0, total: p.total ?? 0 } } satisfies MlResponse);
    };
}

async function handle(req: MlRequest): Promise<unknown> {
    switch (req.op) {
        case "init":
            // Served by the widget itself (scripts/vendor.mjs), never from a CDN.
            // No wasm cache: it loads the runtime through a blob: URL, which the CSP forbids.
            env.useWasmCache = false;
            env.allowLocalModels = false;
            env.backends.onnx.wasm!.wasmPaths = {
                mjs: `${req.vendor}ort/ort-wasm-simd-threaded.asyncify.mjs`,
                wasm: `${req.vendor}ort/ort-wasm-simd-threaded.asyncify.wasm`,
            };
            return null;
        case "embed": {
            embedder ??= pipeline("feature-extraction", EMBED_MODEL, { device: "wasm", dtype: "q8", progress_callback: progress(req.id) });
            const model = await embedder;
            // E5 models are trained with these prefixes; without them retrieval gets worse.
            const out = await model(req.texts.map((t) => `${req.kind}: ${t}`), { pooling: "mean", normalize: true });
            return out.tolist() as number[][];
        }
        case "transcribe": {
            const key = `${req.model}|${req.device}`;
            let asr = recognisers.get(key);
            if (!asr) {
                asr = pipeline("automatic-speech-recognition", req.model, {
                    device: req.device,
                    dtype: req.device === "webgpu" ? { encoder_model: "fp16", decoder_model_merged: "q4" } : "q8",
                    progress_callback: progress(req.id),
                }) as Promise<AutomaticSpeechRecognitionPipeline>;
                recognisers.set(key, asr);
                asr.catch(() => recognisers.delete(key));
            }
            const out = await (await asr)(req.audio, {
                chunk_length_s: 30,
                stride_length_s: 5,
                ...(req.language ? { language: req.language } : {}),
                task: "transcribe",
            });
            return (Array.isArray(out) ? out.map((o) => o.text).join(" ") : out.text).trim();
        }
    }
}

self.onmessage = async (ev: MessageEvent<MlRequest>) => {
    const req = ev.data;
    try {
        postMessage({ id: req.id, ok: true, result: await handle(req) } satisfies MlResponse);
    } catch (e) {
        postMessage({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) } satisfies MlResponse);
    }
};
