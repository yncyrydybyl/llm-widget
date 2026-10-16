/*
 * Helper models next to the LLM, via Transformers.js: sentence embeddings for
 * finding relevant messages and document parts, Whisper for speech, and a small
 * vision model that describes images. In a worker so inference never blocks
 * the page.
 *
 * Embeddings run on WASM on purpose: small, fast enough on one CPU thread, and
 * they leave the GPU to the LLM. Whisper can run on either.
 */
import {
    AutoProcessor,
    Florence2ForConditionalGeneration,
    RawImage,
    env,
    pipeline,
    type AutomaticSpeechRecognitionPipeline,
    type FeatureExtractionPipeline,
    type PreTrainedModel,
    type Processor,
} from "@huggingface/transformers";

export type MlRequest =
    | { id: number; op: "init"; vendor: string }
    | { id: number; op: "embed"; texts: string[]; kind: "query" | "passage" }
    | { id: number; op: "transcribe"; audio: Float32Array; model: string; device: "wasm" | "webgpu"; language?: string }
    | { id: number; op: "describe"; image: Blob };

export type MlResponse =
    | { id: number; ok: true; result: unknown }
    | { id: number; ok: false; error: string }
    | { id: number; progress: { file: string; loaded: number; total: number } };

export const EMBED_MODEL = "Xenova/multilingual-e5-small";

let embedder: Promise<FeatureExtractionPipeline> | null = null;
const recognisers = new Map<string, Promise<AutomaticSpeechRecognitionPipeline>>();
let describer: Promise<{ processor: Processor; model: PreTrainedModel }> | null = null;

/*
 * Florence-2 base, compared on a Radeon 860M with SmolVLM 256M and 500M on a
 * photo, an animal and a screenshot: the only one that was right on all three
 * and never invented details, 1.5 s per image once loaded. Its short caption
 * task: the longer one drifts into "a bear… the dog" at the end. Text in the
 * image comes from OCR, which the caption leaves out.
 */
export const DESCRIBE_MODEL = "onnx-community/Florence-2-base-ft";
const DESCRIBE_DTYPE = { embed_tokens: "fp16", vision_encoder: "fp16", encoder_model: "q4", decoder_model_merged: "q4" };
const FLORENCE_TASK = "<DETAILED_CAPTION>";

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
        case "describe": {
            if (!describer) {
                describer = (async () => ({
                    processor: await AutoProcessor.from_pretrained(DESCRIBE_MODEL, { progress_callback: progress(req.id) }),
                    model: await Florence2ForConditionalGeneration.from_pretrained(DESCRIBE_MODEL, {
                        device: "webgpu",
                        dtype: DESCRIBE_DTYPE as never,
                        progress_callback: progress(req.id),
                    }),
                }))();
                describer.catch(() => (describer = null));
            }
            const { processor, model } = await describer;
            const p = processor as Processor & {
                construct_prompts(task: string): string[];
                post_process_generation(text: string, task: string, size: [number, number]): Record<string, string>;
            };
            const image = await RawImage.fromBlob(req.image);
            const inputs = await p(image, p.construct_prompts(FLORENCE_TASK));
            const ids = (await model.generate({ ...inputs, max_new_tokens: 256 })) as never;
            const text = p.batch_decode(ids, { skip_special_tokens: false })[0];
            return String(p.post_process_generation(text, FLORENCE_TASK, image.size)[FLORENCE_TASK]).trim();
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
