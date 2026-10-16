/*
 * Copies the WebAssembly runtimes and data the in-browser models need into
 * public/vendor/, so the widget serves them itself. The libraries would
 * otherwise fetch them from public CDNs, which the production CSP blocks and
 * which would tell those CDNs who uses the widget. Runs before dev and build.
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
for (const f of ["piper_phonemize.wasm", "piper_phonemize.data"]) copies.push([join(piper, f), join(out, "piper", f)]);

copies.push([join(pkgDir("tesseract.js"), "dist", "worker.min.js"), join(out, "tesseract", "worker.min.js")]);
const core = from("tesseract.js", "tesseract.js-core");
for (const v of ["tesseract-core", "tesseract-core-simd", "tesseract-core-lstm", "tesseract-core-simd-lstm", "tesseract-core-relaxedsimd", "tesseract-core-relaxedsimd-lstm"])
    copies.push([join(core, `${v}.wasm.js`), join(out, "tesseract", `${v}.wasm.js`)]);
for (const lang of ["deu", "eng"])
    copies.push([join(pkgDir(`@tesseract.js-data/${lang}`), "4.0.0_best_int", `${lang}.traineddata.gz`), join(out, "tesseract", "lang", `${lang}.traineddata.gz`)]);

rmSync(out, { recursive: true, force: true });
for (const [src, dst] of copies) {
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst);
}
console.log(`vendor: ${copies.length} files → public/vendor`);
