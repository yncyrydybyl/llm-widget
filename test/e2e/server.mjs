// Static server for the e2e run: the built widget at /, the mock client at /__test__/.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const port = Number(process.env.PORT ?? 4183);
const root = new URL("../../", import.meta.url).pathname; // test/e2e/ → project root

const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".wasm": "application/wasm",
};

createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    let pathname = normalize(decodeURIComponent(url.pathname));
    const test = pathname.startsWith("/__test__/");
    const base = test ? join(root, "test/e2e") : join(root, "dist");
    if (test) pathname = pathname.slice("/__test__".length);
    if (pathname === "/" || pathname.endsWith("/")) pathname += "index.html";
    try {
        const body = await readFile(join(base, pathname));
        res.writeHead(200, {
            "Content-Type": types[extname(pathname)] ?? "application/octet-stream",
            // The widget is framed by the mock client, exactly as Element frames it.
            "X-Frame-Options": "ALLOWALL",
        });
        res.end(body);
    } catch {
        res.writeHead(404).end("not found");
    }
}).listen(port, () => console.log(`test server on http://localhost:${port}`));
