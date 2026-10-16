/*
 * The model behind one small interface. `WebLlmEngine` runs a WebLLM model on the
 * local GPU in a worker; `EchoEngine` (fragment `engine=echo`) needs no GPU and
 * exists for the mock-host tests and for trying the room plumbing quickly.
 */
import { prefillRounds, type ChatMessage } from "./room";

export interface ModelInfo {
    /** WebLLM model id without the quantisation suffix. */
    id: string;
    label: string;
    /** Approximate download/VRAM in MB per quantisation, from WebLLM's prebuilt config. */
    f16MB: number;
    /** The f32 build, for GPUs without the shader-f16 extension; absent when WebLLM has none. */
    f32MB?: number;
    /** Overrides for WebLLM's prebuilt chat config, where it does not load as shipped. */
    chatOpts?: { sliding_window_size?: number; context_window_size?: number; attention_sink_size?: number };
}

/** A curated subset of WebLLM's prebuilt models that fit an ordinary laptop GPU. */
export const MODELS: ModelInfo[] = [
    { id: "SmolLM2-360M-Instruct", label: "SmolLM2 360M (tiny, for testing)", f16MB: 376, f32MB: 580 },
    { id: "Llama-3.2-1B-Instruct", label: "Llama 3.2 1B", f16MB: 879, f32MB: 1129 },
    // WebLLM's config sets both a context window (4096) and a sliding window (512),
    // and then refuses to load it: "Only one of … can be positive". Its library is
    // built for the sliding window (without it the model loads but never answers),
    // which also needs an attention sink size.
    { id: "gemma3-1b-it", label: "Gemma 3 1B", f16MB: 711, chatOpts: { context_window_size: -1, attention_sink_size: 0 } },
    { id: "Qwen2.5-1.5B-Instruct", label: "Qwen 2.5 1.5B", f16MB: 1630, f32MB: 1889 },
    { id: "Llama-3.2-3B-Instruct", label: "Llama 3.2 3B", f16MB: 2264, f32MB: 2952 },
    { id: "Qwen3.5-2B", label: "Qwen 3.5 2B", f16MB: 2245, f32MB: 2592 },
    { id: "gemma-4-E2B-it", label: "Gemma 4 E2B", f16MB: 3387, f32MB: 3863 },
    { id: "Qwen3-4B", label: "Qwen 3 4B", f16MB: 3432, f32MB: 4328 },
    { id: "Qwen3.5-4B", label: "Qwen 3.5 4B", f16MB: 3868, f32MB: 4681 },
    { id: "Llama-3.1-8B-Instruct", label: "Llama 3.1 8B (needs a big GPU)", f16MB: 5001, f32MB: 6101 },
];

export const DEFAULT_MODEL = "Qwen3.5-2B";

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

export interface ChatOptions {
    signal?: AbortSignal;
    /** Largest prompt part processed in one pass; longer prompts go in rounds. */
    chunkChars?: number;
    /** Called before each round of a multi-round prompt. */
    onRound?: (round: number, of: number) => void;
    /** Tokens processed, summed over all rounds; called once the answer is complete. */
    onUsage?: (u: Usage) => void;
}

export interface Usage {
    promptTokens: number;
    completionTokens: number;
}

export interface Engine {
    readonly modelId: string;
    chat(messages: ChatMessage[], onText: (soFar: string) => void, opts?: ChatOptions): Promise<string>;
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
        if (!adapter) {
            const linux = /Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent);
            return {
                problem:
                    "WebGPU is present but no GPU adapter is available." +
                    (linux
                        ? " On Linux, Chrome needs --enable-unsafe-webgpu --enable-features=Vulkan (check chrome://gpu)."
                        : " Check that hardware acceleration is on (chrome://gpu)."),
                f16: false,
            };
        }
        // A software adapter (SwiftShader) loads a model and then never finishes an
        // answer; seen in headless Chrome on a Radeon 860M.
        const info = adapter.info as GPUAdapterInfo & { isFallbackAdapter?: boolean };
        if (info.isFallbackAdapter || /swiftshader/i.test(`${info.vendor} ${info.architecture} ${info.description}`))
            return {
                problem: "WebGPU runs in software (SwiftShader) here, not on the GPU, so a model would never finish an answer. Turn on hardware acceleration (check chrome://gpu).",
                f16: false,
            };
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

    async chat(messages: ChatMessage[], onText: (soFar: string) => void, opts: ChatOptions = {}): Promise<string> {
        // Qwen3 would otherwise think at length before every answer, acknowledgements included.
        const extra_body = /^Qwen3/.test(this.modelId) ? { enable_thinking: false } : undefined;
        const { head, rounds } = prefillRounds(messages, opts.chunkChars ?? Infinity);
        const history: ChatMessage[] = [...head];
        const usage: Usage = { promptTokens: 0, completionTokens: 0 };
        const count = (u?: { prompt_tokens?: number; completion_tokens?: number } | null): void => {
            usage.promptTokens += u?.prompt_tokens ?? 0;
            usage.completionTokens += u?.completion_tokens ?? 0;
        };
        const abort = (): void => this.engine.interruptGenerate();
        opts.signal?.addEventListener("abort", abort);
        try {
            // Every round but the last only fills the KV cache. The acknowledgement
            // must end on its own (finish_reason "stop"): a reply cut by max_tokens
            // makes WebLLM discard the cache and prefill everything again.
            for (let i = 0; i < rounds.length - 1; i++) {
                opts.onRound?.(i + 1, rounds.length);
                history.push({ role: "user", content: rounds[i] });
                const r = await this.engine.chat.completions.create({
                    messages: history,
                    temperature: 0,
                    max_tokens: 16,
                    extra_body,
                });
                count(r.usage);
                if (opts.signal?.aborted) return "";
                history.push({ role: "assistant", content: r.choices[0]?.message.content ?? "" });
            }
            if (rounds.length > 1) opts.onRound?.(rounds.length, rounds.length);
            history.push({ role: "user", content: rounds[rounds.length - 1] ?? "" });
            const stream = await this.engine.chat.completions.create({
                messages: history,
                stream: true,
                stream_options: { include_usage: true },
                temperature: 0.6,
                max_tokens: 768,
                extra_body,
            });
            let text = "";
            for await (const chunk of stream) {
                text += chunk.choices[0]?.delta?.content ?? "";
                if (chunk.usage) count(chunk.usage);
                else onText(text);
            }
            opts.onUsage?.(usage);
            return text;
        } finally {
            opts.signal?.removeEventListener("abort", abort);
        }
    }

    async unload(): Promise<void> {
        // After a lost device the engine may never answer; do not wait for it forever.
        await Promise.race([this.engine.unload().catch(() => undefined), new Promise((r) => setTimeout(r, 2000))]);
        this.worker.terminate();
    }
}

export async function loadWebLlm(modelId: string, onProgress: (p: Progress) => void, chatOpts?: ModelInfo["chatOpts"]): Promise<Engine> {
    const webllm = await import("@mlc-ai/web-llm");
    const worker = new Worker(new URL("./llm.worker.ts", import.meta.url), { type: "module" });
    try {
        const engine = await webllm.CreateWebWorkerMLCEngine(
            worker,
            modelId,
            { initProgressCallback: (r) => onProgress({ fraction: r.progress, text: r.text }) },
            chatOpts,
        );
        return new WebLlmEngine(modelId, engine, worker);
    } catch (e) {
        worker.terminate();
        throw e;
    }
}

/** Repeats the request back word by word. Deterministic, instant, no GPU. */
export class EchoEngine implements Engine {
    readonly modelId = "echo";

    async chat(messages: ChatMessage[], onText: (soFar: string) => void, opts: ChatOptions = {}): Promise<string> {
        const last = messages[messages.length - 1]?.content ?? "";
        const request = last.slice(last.lastIndexOf("Request from"));
        const transcript = last.match(/<conversation>\n([\s\S]*)\n<\/conversation>/)?.[1];
        const lines = transcript ? transcript.split("\n").length : 0;
        const answer = `echo (${lines} lines of context): ${request}`;
        let text = "";
        for (const word of answer.split(" ")) {
            text += (text ? " " : "") + word;
            onText(text);
            await new Promise((r) => setTimeout(r, 5));
        }
        // Words stand in for tokens: enough to exercise the counters.
        const words = (t: string): number => t.split(/\s+/).filter(Boolean).length;
        opts.onUsage?.({ promptTokens: messages.reduce((n, m) => n + words(m.content), 0), completionTokens: words(text) });
        return text;
    }

    async unload(): Promise<void> {}
}
