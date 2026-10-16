import { svelte } from "@sveltejs/vite-plugin-svelte";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";

/*
 * Production CSP. The only live channel to the room is postMessage, which CSP does
 * not govern. The one documented relaxation is the model download: WebLLM fetches
 * weights from Hugging Face (which redirects to its *.hf.co CDNs) and the compiled
 * model library (.wasm) from raw.githubusercontent.com, and instantiating that wasm
 * needs 'wasm-unsafe-eval'. Room content never leaves the browser — inference runs
 * on the local GPU. `frame-ancestors` cannot be set from <meta>; the serving nginx
 * adds it.
 */
const MODEL_HOSTS = [
    "https://huggingface.co",
    "https://*.huggingface.co",
    "https://*.hf.co",
    "https://raw.githubusercontent.com",
].join(" ");

const CSP =
    "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; media-src blob:; " +
    `font-src 'self'; connect-src 'self' ${MODEL_HOSTS}; worker-src 'self'; object-src 'none'; ` +
    "frame-src 'none'; form-action 'none'; base-uri 'none'; manifest-src 'none'";

const cspMeta = (): Plugin => ({
    name: "csp-meta",
    apply: "build", // the dev server needs ws: for HMR and inline styles
    transformIndexHtml: () => [
        { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: CSP }, injectTo: "head-prepend" },
    ],
});

// `pnpm dev:https`: a self-signed certificate, for an https Element framing the dev
// server and for reaching it from another machine (WebGPU needs a secure context,
// and only localhost counts as one over plain http).
const https = process.env.HTTPS === "1";

export default defineConfig({
    // Served from https://marcade.store/apps/<id>/<version>/ — relative URLs only.
    base: "./",
    plugins: [svelte(), cspMeta(), ...(https ? [basicSsl()] : [])],
    worker: { format: "es" },
    build: {
        target: "es2022",
        sourcemap: false,
        // Keep workers as separate files: inlining breaks `new Worker(url)`.
        assetsInlineLimit: 0,
        // web-llm is one large module; it loads lazily, on "Load model".
        chunkSizeWarningLimit: 8000,
    },
    server: {
        // Element and the Player frame the widget; without this Vite refuses to be embedded.
        headers: { "X-Frame-Options": "ALLOWALL" },
        host: https ? true : undefined,
    },
    test: {
        include: ["src/**/*.test.ts"],
    },
});
