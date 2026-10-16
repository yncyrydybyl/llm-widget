/*
 * Copies the WebAssembly runtimes the in-browser models need into
 * public/vendor/, so the code that runs is the code this build ships; the
 * libraries would otherwise fetch it from public CDNs. Data is different: the
 * OCR languages and the voice's phoneme data (21 MB) come from jsDelivr at
 * pinned versions when first used, like the models from Hugging Face (see
 * src/cdn.ts). Runs before dev and build.
 */
import { cpSync, existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const out = join(root, "public", "vendor");
const pkgDir = (pkg) => realpathSync(join(root, "node_modules", pkg));
// pnpm keeps transitive packages out of the top level; they sit next to their dependent.
const from = (parent, pkg) => {
    const dir = join(pkgDir(parent), "..", ...(parent.startsWith("@") ? [".."] : []), pkg);
    if (!existsSync(dir)) throw new Error(`${pkg} not found next to ${parent}`);
    return dir;
};

const copies = [];
const ort = join(from("@huggingface/transformers", "onnxruntime-web"), "dist");
for (const f of ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm"])
    copies.push([join(ort, f), join(out, "ort", f)]);

const piper = join(pkgDir("@diffusionstudio/piper-wasm"), "build");
copies.push([join(piper, "piper_phonemize.wasm"), join(out, "piper", "piper_phonemize.wasm")]);

copies.push([join(pkgDir("tesseract.js"), "dist", "worker.min.js"), join(out, "tesseract", "worker.min.js")]);
const core = from("tesseract.js", "tesseract.js-core");
// OCR runs LSTM only (createWorker(…, 1) in src/ml.ts): tesseract.js then loads
// one of the -lstm cores, picked by the browser's SIMD support.
for (const v of ["tesseract-core-lstm", "tesseract-core-simd-lstm", "tesseract-core-relaxedsimd-lstm"])
    copies.push([join(core, `${v}.wasm.js`), join(out, "tesseract", `${v}.wasm.js`)]);

rmSync(out, { recursive: true, force: true });
for (const [src, dst] of copies) {
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst);
}
console.log(`vendor: ${copies.length} files → public/vendor`);
