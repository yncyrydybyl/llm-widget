// Manual smoke test: real WebLLM model, production build + CSP, mock host.
// Downloads the chosen model on first run. Usage: node test/real/webllm.mjs [modelId]
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";

const model = process.argv[2] ?? "SmolLM2-360M-Instruct";
const server = spawn("node", ["test/e2e/server.mjs"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch({
    channel: "chromium",
    headless: process.env.HEADED ? false : true,
    args: (process.env.GPU_ARGS ?? "--enable-unsafe-webgpu --enable-features=Vulkan --ignore-gpu-blocklist").split(" "),
});
const ctx = await browser.newContext({ baseURL: "http://localhost:4183" });
const page = await ctx.newPage();
page.on("console", (m) => m.type() === "error" && console.log("console:", m.text()));
const ME = "@alice:example.org";
await page.addInitScript(([me]) => {
    window.__TEST_FIXTURE__ = {
        params: { matrix_user_id: me },
        events: [
            { type: "m.room.message", event_id: "$1", sender: "@bob:example.org", origin_server_ts: 1, content: { msgtype: "m.text", body: "Lunch is at 12:30 in the Italian place on Main Street." }, unsigned: {} },
            { type: "m.room.message", event_id: "$2", sender: me, origin_server_ts: 2, content: { msgtype: "m.text", body: "Great, I'll bring Carol." }, unsigned: {} },
        ],
    };
}, [ME]);
await page.goto("/__test__/index.html");
const w = page.frameLocator("iframe");
await w.getByText("in room").waitFor();
await page.waitForTimeout(1500);
console.log("adapter:", await page.frames()[1].evaluate(async () => {
    const a = await navigator.gpu?.requestAdapter();
    return a ? JSON.stringify({ ...a.info, vendor: a.info.vendor, architecture: a.info.architecture, description: a.info.description, f16: a.features.has("shader-f16") }) : "none";
}));
const warn = await w.locator(".note.warn").allTextContents();
console.log("warnings:", warn);
await w.locator("select").selectOption(model);
const t0 = Date.now();
await w.getByRole("button", { name: "Load model" }).click();
try {
    await w.getByText(/^Ready:/).or(w.locator(".note.warn")).first().waitFor({ timeout: 600_000 });
    if (!(await w.getByText(/^Ready:/).count())) throw new Error("load error");
} catch (e) {
    console.log("load failed:", await w.locator("main").innerText());
    process.exitCode = 1;
}
console.log(`loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (!process.exitCode) {
    await page.evaluate(() => window.__toWidget("send_event", { type: "m.room.message", event_id: "$3", room_id: "!room:example.org", sender: "@alice:example.org", origin_server_ts: 3, content: { msgtype: "m.text", body: "!ai where and when is lunch?" }, unsigned: {} }));
    const t1 = Date.now();
    try {
        await w.getByText(/posted to room|error/).waitFor({ timeout: Number(process.env.ANSWER_TIMEOUT ?? 300_000) });
    } catch {
        console.log("no answer yet; UI:", await w.locator(".jobs").innerText());
    }
    console.log(`answered in ${((Date.now() - t1) / 1000).toFixed(1)} s`);
    console.log("sent:", JSON.stringify(await page.evaluate(() => window.__SENT__), null, 1));
    await page.screenshot({ path: "test/real/screenshot.png" });
}
await browser.close();
server.kill();
