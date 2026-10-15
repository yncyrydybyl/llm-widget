import { expect, test, type Page } from "@playwright/test";

const ME = "@alice:example.org";
const msg = (id: string, body: string, ts: number, sender = ME, msgtype = "m.text") => ({
    type: "m.room.message",
    event_id: id,
    room_id: "!room:example.org",
    sender,
    origin_server_ts: ts,
    content: { msgtype, body },
    unsigned: {},
});

async function open(page: Page, fixture: Record<string, unknown>) {
    await page.addInitScript((f) => {
        (window as unknown as { __TEST_FIXTURE__: unknown }).__TEST_FIXTURE__ = f;
    }, fixture);
    await page.goto("/__test__/index.html");
    return page.frameLocator("iframe");
}

const sent = (page: Page) => page.evaluate(() => (window as unknown as { __SENT__: unknown[] }).__SENT__);
const push = (page: Page, ev: unknown) =>
    page.evaluate((e) => (window as unknown as { __toWidget: (a: string, d: unknown) => void }).__toWidget("send_event", e), ev);

test("requests exactly the capabilities it needs", async ({ page }) => {
    const w = await open(page, { params: { engine: "echo", matrix_user_id: ME } });
    await expect(w.getByText("in room")).toBeVisible();
    const caps = await page.evaluate(() => (window as unknown as { __REQUESTED_CAPABILITIES__: string[] }).__REQUESTED_CAPABILITIES__);
    expect(caps.sort()).toEqual(
        [
            "io.element.requires_client",
            "org.matrix.msc2762.receive.event:m.room.message#m.text",
            "org.matrix.msc2762.receive.event:m.room.message#m.notice",
            "org.matrix.msc2762.send.event:m.room.message#m.notice",
        ].sort(),
    );
});

test("answers a live !ai request with the history as context", async ({ page }) => {
    const w = await open(page, {
        params: { engine: "echo", matrix_user_id: ME },
        // History, including an old request: context only, never answered.
        events: [msg("$1", "we meet at 3", 1), msg("$2", "!ai old question", 2)],
    });
    await expect(w.getByText("in room")).toBeVisible();
    await w.getByRole("button", { name: "Load model" }).click();
    await expect(w.getByText("Ready: echo")).toBeVisible();

    await push(page, msg("$3", "!ai when do we meet?", 3));
    await expect(w.getByText("posted to room")).toBeVisible();

    const out = (await sent(page)) as { type: string; content: Record<string, unknown> }[];
    expect(out).toHaveLength(1);
    expect(out[0].content.msgtype).toBe("m.notice");
    expect(out[0].content["m.relates_to"]).toEqual({ "m.in_reply_to": { event_id: "$3" } });
    expect(String(out[0].content.body)).toContain("Request from alice: when do we meet?");
});

test("queues requests until the model is loaded, ignores others' requests by default", async ({ page }) => {
    const w = await open(page, { params: { engine: "echo", matrix_user_id: ME } });
    await expect(w.getByText("in room")).toBeVisible();
    await push(page, msg("$a", "!ai from bob", 10, "@bob:example.org"));
    await push(page, msg("$b", "!ai summarise", 11));
    await expect(w.getByText("waiting for model")).toBeVisible();
    await w.getByRole("button", { name: "Load model" }).click();
    await expect(w.getByText("posted to room")).toBeVisible();
    expect(await sent(page)).toHaveLength(1);
});

test("private questions never post", async ({ page }) => {
    const w = await open(page, { params: { engine: "echo", matrix_user_id: ME }, events: [msg("$1", "hello", 1)] });
    await w.getByRole("button", { name: "Load model" }).click();
    await w.getByRole("textbox", { name: "Private question" }).fill("what was said?");
    await w.getByRole("button", { name: "Ask" }).click();
    await expect(w.getByText("done", { exact: true })).toBeVisible();
    expect(await sent(page)).toHaveLength(0);
});

test("shows the consent problem when nothing is approved", async ({ page }) => {
    const w = await open(page, { params: { engine: "echo" }, deny: true });
    await expect(w.getByText("no permission")).toBeVisible();
});
