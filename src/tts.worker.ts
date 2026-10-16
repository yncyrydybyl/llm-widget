/*
 * Speech output with Piper (VITS voices, ONNX on WASM). Runs on the CPU so it
 * never competes with the LLM for the GPU, and in a worker so the page stays
 * responsive while it synthesises. Voices download from Hugging Face on first
 * use and are kept in the origin-private file system.
 */
import { TtsSession } from "@mintplex-labs/piper-tts-web";
import { PIPER_DATA } from "./cdn";

export type TtsRequest = { id: number; op: "init"; vendor: string } | { id: number; op: "speak"; text: string; voiceId: string };
export type TtsResponse =
    | { id: number; ok: true; result: unknown }
    | { id: number; ok: false; error: string }
    | { id: number; progress: { file: string; loaded: number; total: number } };

let vendor = "";

self.onmessage = async (ev: MessageEvent<TtsRequest>) => {
    const req = ev.data;
    try {
        if (req.op === "init") {
            vendor = req.vendor;
            postMessage({ id: req.id, ok: true, result: null } satisfies TtsResponse);
            return;
        }
        // TtsSession is a singleton that loads its voice once: drop it to switch voices.
        if (TtsSession._instance && TtsSession._instance.voiceId !== req.voiceId) TtsSession._instance = null;
        const session = await TtsSession.create({
            voiceId: req.voiceId as never,
            progress: (p: { url: string; loaded: number; total: number }) =>
                postMessage({ id: req.id, progress: { file: p.url, loaded: p.loaded, total: p.total } } satisfies TtsResponse),
            wasmPaths: {
                onnxWasm: `${vendor}ort/`,
                piperData: PIPER_DATA,
                piperWasm: `${vendor}piper/piper_phonemize.wasm`,
            },
        });
        const wav = await session.predict(req.text);
        postMessage({ id: req.id, ok: true, result: wav } satisfies TtsResponse);
    } catch (e) {
        postMessage({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) } satisfies TtsResponse);
    }
};
