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
type Sent = { type: string; content: Record<string, unknown> };
const messages = async (page: Page) => ((await sent(page)) as Sent[]).filter((e) => e.type === "m.room.message");
const presence = async (page: Page) => ((await sent(page)) as Sent[]).filter((e) => e.type === PRESENCE);
const PRESENCE = "de.datanauten.llm_widget.presence";
const peer = (id: string, sender: string, ts: number, content: Record<string, unknown>) => ({
    type: PRESENCE,
    event_id: id,
    room_id: "!room:example.org",
    sender,
    origin_server_ts: ts,
    content: { device: `dev-${id}`, online: true, model: null, everyone: false, prefix: "!ai", ...content },
    unsigned: {},
});
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
            "org.matrix.msc2762.receive.event:m.room.message#m.audio",
            "org.matrix.msc2762.receive.event:m.room.message#m.image",
            "org.matrix.msc2762.receive.event:m.room.message#m.file",
            "org.matrix.msc4039.download_file",
            "org.matrix.msc2762.send.event:de.datanauten.llm_widget.presence",
            "org.matrix.msc2762.receive.event:de.datanauten.llm_widget.presence",
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
    const answers = out.filter((e) => e.type === "m.room.message");
    expect(answers).toHaveLength(1);
    expect(answers[0].content.msgtype).toBe("m.notice");
    expect(answers[0].content["m.relates_to"]).toEqual({ "m.in_reply_to": { event_id: "$3" } });
    expect(String(answers[0].content.body)).toContain("Request from alice: when do we meet?");
});

test("queues requests until the model is loaded, ignores others' requests by default", async ({ page }) => {
    const w = await open(page, { params: { engine: "echo", matrix_user_id: ME } });
    await expect(w.getByText("in room")).toBeVisible();
    await push(page, msg("$a", "!ai from bob", 10, "@bob:example.org"));
    await push(page, msg("$b", "!ai summarise", 11));
    await expect(w.getByText("waiting for model")).toBeVisible();
    await w.getByRole("button", { name: "Load model" }).click();
    await expect(w.getByText("posted to room")).toBeVisible();
    expect(await messages(page)).toHaveLength(1);
});

test("private questions never post", async ({ page }) => {
    const w = await open(page, { params: { engine: "echo", matrix_user_id: ME }, events: [msg("$1", "hello", 1)] });
    await w.getByRole("button", { name: "Load model" }).click();
    await w.getByRole("textbox", { name: "Private question" }).fill("what was said?");
    await w.getByRole("button", { name: "Ask" }).click();
    await expect(w.getByText("done", { exact: true })).toBeVisible();
    expect(await messages(page)).toHaveLength(0);
});

test("reloads delayed history before private and live requests", async ({ page }) => {
    const w = await open(page, { params: { engine: "echo", matrix_user_id: ME }, events: [] });
    await expect(w.getByText("in room")).toBeVisible();
    await w.getByRole("button", { name: "Load model" }).click();
    await page.evaluate((events) => {
        (window as unknown as { __TEST_FIXTURE__: { events: unknown[] } }).__TEST_FIXTURE__.events = events;
    }, [msg("$old", "The meeting is at three", 1), msg("$old-request", "!ai old request", 2)]);
    const reply = msg("$new", "!ai tr en", 3);
    (reply.content as Record<string, unknown>)["m.relates_to"] = { "m.in_reply_to": { event_id: "$old" } };
    await push(page, reply);
    await expect.poll(async () => (await messages(page)).length, { timeout: 10000 }).toBe(1);
    expect(String((await messages(page))[0].content.body)).toContain("Translate this text into English");
    await w.getByRole("textbox", { name: "Private question" }).fill("When is the meeting?");
    await w.getByRole("button", { name: "Ask" }).click();
    await expect(w.getByText("done", { exact: true })).toBeVisible();
    await expect(w.locator("summary", { hasText: "Conversation the model sees" })).toContainText("(3)");
    expect(await messages(page)).toHaveLength(1);
});

test("warns when a conversation request has no earlier context", async ({ page }) => {
    const w = await open(page, { params: { engine: "echo", matrix_user_id: ME }, events: [] });
    await w.getByRole("button", { name: "Load model" }).click();
    await w.getByRole("textbox", { name: "Private question" }).fill("What happened?");
    await w.getByRole("button", { name: "Ask" }).click();
    await expect(w.getByText("No earlier conversation is available to the model.")).toBeVisible();
});

test("reloads delayed history for a private question", async ({ page }) => {
    const w = await open(page, { params: { engine: "echo", matrix_user_id: ME }, events: [] });
    await expect(w.getByText("in room")).toBeVisible();
    await w.getByRole("button", { name: "Load model" }).click();
    await page.evaluate((events) => {
        (window as unknown as { __TEST_FIXTURE__: { events: unknown[] } }).__TEST_FIXTURE__.events = events;
    }, [msg("$old", "The meeting is at three", 1)]);
    await w.getByRole("textbox", { name: "Private question" }).fill("When is the meeting?");
    await w.getByRole("button", { name: "Ask" }).click();
    await expect(w.getByText("echo (1 lines of context)", { exact: false })).toBeVisible();
    expect(await messages(page)).toHaveLength(0);
});

test("handles live requests also returned by a history refresh only once", async ({ page }) => {
    const w = await open(page, { params: { engine: "echo", matrix_user_id: ME }, events: [] });
    await expect(w.getByText("in room")).toBeVisible();
    await w.getByRole("button", { name: "Load model" }).click();
    const first = msg("$first", "!ai first?", 1);
    const second = msg("$second", "!ai second?", 2);
    await page.evaluate((events) => {
        (window as unknown as { __TEST_FIXTURE__: { events: unknown[] } }).__TEST_FIXTURE__.events = events;
    }, [first, second]);
    await push(page, first);
    await push(page, second);
    await push(page, second);
    await expect.poll(async () => (await messages(page)).length, { timeout: 10000 }).toBe(2);
    const replies = (await messages(page)).map((m) => m.content["m.relates_to"]);
    expect(replies).toEqual([
        { "m.in_reply_to": { event_id: "$first" } },
        { "m.in_reply_to": { event_id: "$second" } },
    ]);
});

test("reads history types concurrently for a request", async ({ page }) => {
    const w = await open(page, { params: { engine: "echo", matrix_user_id: ME }, events: [] });
    await expect(w.getByText("in room")).toBeVisible();
    await w.getByRole("button", { name: "Load model" }).click();
    await page.evaluate(() => {
        const host = window as unknown as { __TEST_FIXTURE__: { readDelay: number }; __MAX_READ_IN_FLIGHT__: number };
        host.__TEST_FIXTURE__.readDelay = 100;
        host.__MAX_READ_IN_FLIGHT__ = 0;
    });
    await w.getByRole("textbox", { name: "Private question" }).fill("What happened?");
    await w.getByRole("button", { name: "Ask" }).click();
    await expect(w.getByText("done", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __MAX_READ_IN_FLIGHT__: number }).__MAX_READ_IN_FLIGHT__)).toBeGreaterThan(1);
});

test("shows the consent problem when nothing is approved", async ({ page }) => {
    const w = await open(page, { params: { engine: "echo" }, deny: true });
    await expect(w.getByText("no permission")).toBeVisible();
});

test("counts the widgets in the room and answers a newcomer's probe", async ({ page }) => {
    const now = Date.now();
    const w = await open(page, {
        params: { engine: "echo", matrix_user_id: ME },
        // Bob's widget announced itself a minute ago, with a model and answering everyone.
        events: [peer("$p1", "@bob:example.org", now - 60_000, { instance: "bob-1", model: "Llama", everyone: true, donated: { answers: 2, promptTokens: 900, completionTokens: 80, gpuMs: 12_000 } })],
    });
    await expect(w.getByText("2 widgets")).toBeVisible();
    await expect(w.getByText("1 can answer you")).toBeVisible();
    // On opening, this widget announced itself and asked the others to do the same.
    const first = await presence(page);
    expect(first[0].content).toMatchObject({ online: true, model: null, probe: true });

    // Carol's widget opens and probes: this one answers, without a probe of its own.
    await push(page, peer("$p2", "@carol:example.org", now, { instance: "carol-1", probe: true }));
    await expect(w.getByText("3 widgets")).toBeVisible();
    await expect.poll(async () => (await presence(page)).length, { timeout: 5000 }).toBe(2);
    expect((await presence(page))[1].content.probe).toBeUndefined();

    // Loading a model and answering are announced, with the donation.
    await w.getByRole("button", { name: "Load model" }).click();
    await push(page, msg("$q", "!ai hello", now + 1));
    await expect(w.getByText("posted to room")).toBeVisible();
    await expect.poll(async () => (await presence(page)).at(-1)?.content.donated, { timeout: 5000 }).toMatchObject({ answers: 1 });
    const answer = (await messages(page))[0].content["de.datanauten.llm_widget"] as Record<string, number>;
    expect(answer.completion_tokens).toBeGreaterThan(0);

    await w.locator("summary", { hasText: "open in this room" }).click();
    await expect(w.getByRole("row", { name: /bob/ })).toContainText("12.0 s");
    await expect(w.getByRole("row", { name: /alice/ })).toBeVisible();
});

test("shortcuts: translating a replied-to message, and help without a model", async ({ page }) => {
    const w = await open(page, {
        params: { engine: "echo", matrix_user_id: ME },
        events: [msg("$1", "Wir treffen uns um drei", 1, "@bob:example.org"), msg("$2", "unrelated", 2)],
    });
    await expect(w.getByText("in room")).toBeVisible();

    // Help is answered at once, before any model is loaded.
    await push(page, msg("$h", "!ai help", 3));
    await expect.poll(async () => (await messages(page)).length, { timeout: 5000 }).toBe(1);
    expect(String((await messages(page))[0].content.body)).toContain("!ai tr <language> [text]");

    await w.getByRole("button", { name: "Load model" }).click();
    const reply = msg("$t", "!ai tr en", 4);
    (reply.content as Record<string, unknown>)["m.relates_to"] = { "m.in_reply_to": { event_id: "$1" } };
    await push(page, reply);
    await expect.poll(async () => (await messages(page)).length, { timeout: 5000 }).toBe(2);
    // The echo engine repeats the request; the subject went in the prompt instead of the room history.
    const body = String((await messages(page))[1].content.body);
    expect(body).toContain("Translate this text into English");
    expect(body).toContain("0 lines of context");
});

/** Encrypts like a Matrix client: AES-CTR-256, SHA-256 over the ciphertext. */
async function encryptFile(text: string) {
    const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64").replace(/=+$/, "");
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const iv = new Uint8Array(16);
    iv.set(crypto.getRandomValues(new Uint8Array(8)));
    const key = await crypto.subtle.importKey("raw", raw, { name: "AES-CTR" }, false, ["encrypt"]);
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CTR", counter: iv, length: 64 }, key, new TextEncoder().encode(text)));
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    return {
        body: Buffer.from(data).toString("base64"),
        file: { url: "mxc://example.org/secret", key: { kty: "oct", alg: "A256CTR", k: b64(raw).replace(/\+/g, "-").replace(/\//g, "_"), ext: true }, iv: b64(iv), hashes: { sha256: b64(hash) }, v: "v2" },
    };
}

test("reads an encrypted text file it is asked about", async ({ page }) => {
    const enc = await encryptFile("Agenda: budget 5k, launch on Friday.");
    const file = {
        type: "m.room.message",
        event_id: "$f",
        room_id: "!room:example.org",
        sender: "@bob:example.org",
        origin_server_ts: 1,
        content: { msgtype: "m.file", body: "agenda.txt", info: { mimetype: "text/plain" }, file: enc.file },
        unsigned: {},
    };
    const w = await open(page, { params: { engine: "echo", matrix_user_id: ME }, events: [file], bodies: { "mxc://example.org/secret": enc.body } });
    await expect(w.getByText("in room")).toBeVisible();

    // read: the decrypted text as it is, no model needed.
    await push(page, msg("$r", "!ai read", 2));
    await expect.poll(async () => (await messages(page)).length, { timeout: 5000 }).toBe(1);
    expect((await messages(page))[0].content.body).toBe("Agenda: budget 5k, launch on Friday.");

    // A question sent as a reply to the file gets its text as the subject.
    await w.getByRole("button", { name: "Load model" }).click();
    const q = msg("$q", "!ai what is the budget?", 3);
    (q.content as Record<string, unknown>)["m.relates_to"] = { "m.in_reply_to": { event_id: "$f" } };
    await push(page, q);
    await expect.poll(async () => (await messages(page)).length, { timeout: 5000 }).toBe(2);
    expect(String((await messages(page))[1].content.body)).toContain("what is the budget?");
});
