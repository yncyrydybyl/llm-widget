/*
 * The model behind one small interface. `WebLlmEngine` runs a WebLLM model on the
 * local GPU in a worker; `EchoEngine` (fragment `engine=echo`) needs no GPU and
 * exists for the mock-host tests and for trying the room plumbing quickly.
 */
import type { ChatMessage } from "./room";

export interface ModelInfo {
    /** WebLLM model id without the quantisation suffix. */
    id: string;
    label: string;
    /** Approximate download/VRAM in MB per quantisation, from WebLLM's prebuilt config. */
    f16MB: number;
    /** The f32 build, for GPUs without the shader-f16 extension; absent when WebLLM has none. */
    f32MB?: number;
}

/** A curated subset of WebLLM's prebuilt models that fit an ordinary laptop GPU. */
export const MODELS: ModelInfo[] = [
    { id: "SmolLM2-360M-Instruct", label: "SmolLM2 360M (tiny, for testing)", f16MB: 376, f32MB: 580 },
    { id: "Llama-3.2-1B-Instruct", label: "Llama 3.2 1B", f16MB: 879, f32MB: 1129 },
    { id: "gemma3-1b-it", label: "Gemma 3 1B", f16MB: 711 },
    { id: "Qwen2.5-1.5B-Instruct", label: "Qwen 2.5 1.5B", f16MB: 1630, f32MB: 1889 },
    { id: "Llama-3.2-3B-Instruct", label: "Llama 3.2 3B", f16MB: 2264, f32MB: 2952 },
    { id: "Qwen3-4B", label: "Qwen 3 4B (reasoning)", f16MB: 3432, f32MB: 4328 },
    { id: "Llama-3.1-8B-Instruct", label: "Llama 3.1 8B (needs a big GPU)", f16MB: 5001, f32MB: 6101 },
];

export const DEFAULT_MODEL = "Qwen2.5-1.5B-Instruct";

/** Models usable on this GPU: without shader-f16 only those with an f32 build. */
export function availableModels(f16: boolean): ModelInfo[] {
    return f16 ? MODELS : MODELS.filter((m) => m.f32MB !== undefined);
}

export function webLlmId(m: ModelInfo, f16: boolean): string {
    return `${m.id}-${f16 ? "q4f16_1" : "q4f32_1"}-MLC`;
}

export function sizeMB(m: ModelInfo, f16: boolean): number {
    return f16 ? m.f16MB : (m.f32MB ?? m.f16MB);
}

export interface Progress {
    fraction: number;
    text: string;
}

export interface Engine {
    readonly modelId: string;
    chat(messages: ChatMessage[], onText: (soFar: string) => void, signal?: AbortSignal): Promise<string>;
    unload(): Promise<void>;
}

export interface GpuStatus {
    problem: string | null;
    /** shader-f16: the smaller, faster q4f16 builds need it. */
    f16: boolean;
}

export async function webGpuStatus(): Promise<GpuStatus> {
    if (!("gpu" in navigator) || !navigator.gpu)
        return { problem: "This browser has no WebGPU (try a current Chrome, Edge or Firefox).", f16: false };
    try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) return { problem: "WebGPU is present but no GPU adapter is available.", f16: false };
        return { problem: null, f16: adapter.features.has("shader-f16") };
    } catch (e) {
        return { problem: `WebGPU failed: ${String(e)}`, f16: false };
    }
}

export async function isCached(modelId: string): Promise<boolean> {
    try {
        const webllm = await import("@mlc-ai/web-llm");
        return await webllm.hasModelInCache(modelId);
    } catch {
        return false;
    }
}

class WebLlmEngine implements Engine {
    constructor(
        readonly modelId: string,
        private engine: import("@mlc-ai/web-llm").WebWorkerMLCEngine,
        private worker: Worker,
    ) {}

    async chat(messages: ChatMessage[], onText: (soFar: string) => void, signal?: AbortSignal): Promise<string> {
        const stream = await this.engine.chat.completions.create({
            messages,
            stream: true,
            temperature: 0.6,
            max_tokens: 768,
        });
        let text = "";
        const abort = (): void => this.engine.interruptGenerate();
        signal?.addEventListener("abort", abort);
        try {
            for await (const chunk of stream) {
                text += chunk.choices[0]?.delta?.content ?? "";
                onText(text);
            }
        } finally {
            signal?.removeEventListener("abort", abort);
        }
        return text;
    }

    async unload(): Promise<void> {
        await this.engine.unload().catch(() => undefined);
        this.worker.terminate();
    }
}

export async function loadWebLlm(modelId: string, onProgress: (p: Progress) => void): Promise<Engine> {
    const webllm = await import("@mlc-ai/web-llm");
    const worker = new Worker(new URL("./llm.worker.ts", import.meta.url), { type: "module" });
    try {
        const engine = await webllm.CreateWebWorkerMLCEngine(worker, modelId, {
            initProgressCallback: (r) => onProgress({ fraction: r.progress, text: r.text }),
        });
        return new WebLlmEngine(modelId, engine, worker);
    } catch (e) {
        worker.terminate();
        throw e;
    }
}

/** Repeats the request back word by word. Deterministic, instant, no GPU. */
export class EchoEngine implements Engine {
    readonly modelId = "echo";

    async chat(messages: ChatMessage[], onText: (soFar: string) => void): Promise<string> {
        const last = messages[messages.length - 1]?.content ?? "";
        const request = last.slice(last.lastIndexOf("Request from"));
        const lines = (last.match(/<conversation>\n([\s\S]*)\n<\/conversation>/)?.[1] ?? "").split("\n").length;
        const answer = `echo (${lines} lines of context): ${request}`;
        let text = "";
        for (const word of answer.split(" ")) {
            text += (text ? " " : "") + word;
            onText(text);
            await new Promise((r) => setTimeout(r, 5));
        }
        return text;
    }

    async unload(): Promise<void> {}
}
