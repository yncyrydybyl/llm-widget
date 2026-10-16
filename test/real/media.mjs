// Manual smoke test of the helper models in a real browser: OCR, PDF text,
// Whisper, voice output, history search and a question about a PDF.
// Usage: node test/real/media.mjs <dir with scan.png, plan.pdf, voice.ogg[, bee.jpg, cat.jpg, screen.png]> [modelId]
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const model = process.argv[3] ?? "Qwen3.5-2B";
const only = (process.env.ONLY ?? "ocr,pdf,voice,describe,tts,search,ask,askimage").split(",");
const photos = ["bee.jpg", "cat.jpg", "screen.png"].filter((f) => existsSync(join(dir, f)));
const b64 = (f) => readFileSync(join(dir, f)).toString("base64");
const server = spawn("node", ["test/e2e/server.mjs"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch({
    channel: "chromium",
    headless: !process.env.HEADED,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required", "--use-angle=vulkan"],
    // Headless otherwise may pick SwiftShader, WebGPU on the CPU: answers never finish.
    ignoreDefaultArgs: ["--use-angle=swiftshader-webgl"],
});
const ctx = await browser.newContext({ baseURL: "http://localhost:4183" });
const page = await ctx.newPage();
page.on("console", (m) => m.type() === "error" && console.log("console:", m.text().slice(0, 300)));
ctx.on("response", (r) => r.status() >= 400 && console.log("http", r.status(), r.url().slice(0, 200)));
page.on("pageerror", (e) => console.log("pageerror:", e.message));
page.on("worker", (wk) => wk.on("console", (m) => m.type() === "error" && console.log("worker:", m.text().slice(0, 300))));

const ME = "@alice:example.org";
const ev = (id, ts, content, sender = "@bob:example.org") => ({ type: "m.room.message", event_id: id, room_id: "!room:example.org", sender, origin_server_ts: ts, content, unsigned: {} });
const filler = Array.from({ length: 40 }, (_, i) => ev(`$n${i}`, 100 + i, { msgtype: "m.text", body: `Nachricht ${i}: wir reden über das Mittagessen, das Wetter und den Fußball.` }, i % 2 ? ME : "@carol:example.org"));
const events = [
    ev("$wifi", 50, { msgtype: "m.text", body: "Das WLAN-Passwort für das Büro ist tulpe42." }),
    ...filler,
    ev("$img", 200, { msgtype: "m.image", body: "scan.png", url: "mxc://x/img", info: { mimetype: "image/png" } }),
    ev("$pdf", 201, { msgtype: "m.file", body: "plan.pdf", url: "mxc://x/pdf", info: { mimetype: "application/pdf" } }),
    ev("$voice", 202, { msgtype: "m.audio", body: "Voice message", url: "mxc://x/voice", info: { mimetype: "audio/ogg" }, "org.matrix.msc3245.voice": {} }),
    ...photos.map((f, i) => ev(`$photo${i}`, 210 + i, { msgtype: "m.image", body: f, url: `mxc://x/photo${i}`, info: { mimetype: f.endsWith(".png") ? "image/png" : "image/jpeg" } })),
];
const photoBodies = Object.fromEntries(photos.map((f, i) => [`mxc://x/photo${i}`, b64(f)]));
await page.addInitScript(([me, events, bodies, model, rec]) => {
    localStorage.setItem("llm-widget.settings", JSON.stringify({ modelId: model, contextSize: 10, search: true, recogniser: rec }));
    window.__TEST_FIXTURE__ = { params: { matrix_user_id: me }, events, bodies };
}, [ME, events, { "mxc://x/img": b64("scan.png"), "mxc://x/pdf": b64("plan.pdf"), "mxc://x/voice": b64("voice.ogg"), ...photoBodies }, model, process.env.REC ?? "base"]);
await page.goto("/__test__/index.html");
const w = page.frameLocator("iframe");
await w.getByText("in room").waitFor();

let n = 0;
async function ask(body, replyTo, timeout = 600_000) {
    const content = { msgtype: "m.text", body };
    if (replyTo) content["m.relates_to"] = { "m.in_reply_to": { event_id: replyTo } };
    const before = await page.evaluate(() => window.__SENT__.filter((e) => e.type === "m.room.message").length);
    const t0 = Date.now();
    await page.evaluate((e) => window.__toWidget("send_event", e), ev(`$ask${++n}`, 1000 + n, content, ME));
    const notes = setInterval(async () => {
        const t = await w.locator(".job").first().locator(".small").allTextContents().catch(() => []);
        if (t.length) process.stdout.write(`\r   ${t.join(" | ").slice(0, 150).padEnd(150)}`);
    }, 1000);
    try {
        await page.waitForFunction((b) => window.__SENT__.filter((e) => e.type === "m.room.message").length > b, before, { timeout, polling: 500 });
        const out = await page.evaluate(() => window.__SENT__.filter((e) => e.type === "m.room.message").at(-1).content.body);
        console.log(`\n${body} → (${((Date.now() - t0) / 1000).toFixed(1)} s)\n${out}\n`);
    } catch {
        console.log(`\n${body} → no answer. Job:`, (await w.locator(".job").first().innerText()).slice(0, 500));
    } finally {
        clearInterval(notes);
    }
}

if (only.includes("ocr")) await ask("!ai read", "$img");
if (only.includes("pdf")) await ask("!ai read", "$pdf");
if (only.includes("voice")) await ask("!ai transcribe", "$voice");
if (only.includes("describe")) for (let i = 0; i < photos.length; i++) await ask("!ai describe", `$photo${i}`);
if (only.some((o) => ["tts", "search", "ask", "askimage"].includes(o))) {
    const t0 = Date.now();
    await w.getByRole("button", { name: "Load model" }).click();
    await w.getByText(/^Ready:/).waitFor({ timeout: 900_000 });
    console.log(`model loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
if (only.includes("search")) await ask("!ai wie ist das WLAN-Passwort?");
if (only.includes("ask")) await ask("!ai Wer ist für das Design verantwortlich und was kostet es?", "$pdf");
if (only.includes("askimage") && photos.length) await ask("!ai Was ist auf dem Bild zu sehen?", "$photo0");
if (only.includes("tts")) {
    const t0 = Date.now();
    await page.frames()[1].evaluate(() => {
        // Record playback: the test cannot hear it.
        window.__played = [];
        const play = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function () {
            this.addEventListener("loadedmetadata", () => window.__played.push(this.duration), { once: true });
            return play.call(this);
        };
    });
    await w.getByRole("button", { name: "read aloud" }).first().click();
    await w.getByRole("button", { name: "reading…" }).waitFor({ timeout: 5_000 });
    const notes = setInterval(async () => {
        const t = await w.locator(".actions .small").allTextContents().catch(() => []);
        if (t.length) process.stdout.write(`\r   ${t.join(" | ").slice(0, 150).padEnd(150)}`);
    }, 1000);
    await w.getByRole("button", { name: "reading…" }).waitFor({ state: "detached", timeout: 600_000 });
    clearInterval(notes);
    const err = await w.getByText(/Could not read aloud/).count();
    const played = await page.frames()[1].evaluate(() => window.__played);
    console.log(`\nread aloud: ${err ? await w.getByText(/Could not read aloud/).innerText() : `played ${JSON.stringify(played)} s of audio`} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}
await page.screenshot({ path: "test/real/media.png", fullPage: true });
await browser.close();
server.kill();
