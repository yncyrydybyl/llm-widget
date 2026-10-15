# Room LLM: an in-browser LLM as a Matrix widget

A Matrix widget that runs a language model **entirely in your browser** (WebLLM on
WebGPU, in a Web Worker) and lets it work with the room you are in. Write

```
!ai what did we decide about the venue?
```

in the room. The widget gives the model the recent conversation as context and posts the
answer as an `m.notice` reply. No backend, no API key, and room content never leaves
your machine. The only network traffic is the one-time model download from Hugging Face.

## Try it

```sh
pnpm install
pnpm dev                       # http://localhost:5173
```

Standalone (open the URL directly) you get a local fake room: type messages, and
start one with `!ai` to ask the model.

In Element, add it to a room:

```
/addwidget http://localhost:5173/#/?matrix_user_id=$matrix_user_id&theme=$org.matrix.msc2873.client_theme
```

Open the widget, approve the permissions, pick a model and press **Load model**.
Nothing is downloaded until then; the browser caches the model for next time.

### Over HTTPS

WebGPU needs a secure context. Plain `http://localhost` qualifies; a LAN IP or hostname
does not, and an https Element may refuse to frame an http widget. For those cases:

```sh
pnpm dev:https                 # self-signed cert, listens on all interfaces
```

Open `https://localhost:5173/` (or the network URL) **once directly in the browser and
accept the certificate**. Otherwise the iframe in Element stays blank, because there is
no visible certificate prompt inside a frame. Then add the widget with the https URL:

```
/addwidget https://localhost:5173/#/?matrix_user_id=$matrix_user_id&theme=$org.matrix.msc2873.client_theme
```

Other people in the room need a URL their browser can reach. For real use, deploy the
`dist/` build to any static https host (or Marcade).

`#/?engine=echo` swaps the model for a GPU-free echo engine (used by the e2e tests).

## How it behaves

- **Whose requests it answers:** by default only your own `!ai …` messages, so when
  several people have the widget open, each request gets exactly one answer, from the
  asker's own browser. "Answer everyone's requests" turns it into a room bot for as long
  as your widget is open. If more than one person enables that, a request can be answered
  twice; the widget skips a request when it sees another widget's answer first.
  Without `matrix_user_id` in the URL it cannot tell whose message is whose and answers
  everyone.
- **Context:** the last *N* text messages and notices (default 30, bounded to about 8,000
  characters for the 4k-token window of the small models). History read at startup is
  context only; only messages that arrive while the widget is open count as requests.
- **Private questions:** the input box in the widget asks about the room without posting
  anything.
- **Answers** are `m.notice` events with an `m.in_reply_to` relation and a
  `de.minagawa.llm_widget` marker, so other instances recognise model output and never
  answer it.
- **Models:** a curated list of WebLLM builds, from SmolLM2 360M (0.4 GB, for testing) to
  Llama 3.1 8B. GPUs without the `shader-f16` extension get the larger `q4f32` builds
  automatically. Reasoning output (`<think>…</think>`) is stripped before posting.

## Capabilities requested

| Capability | Why |
|---|---|
| `io.element.requires_client` | Useless outside a client; hides the pop-out button |
| `org.matrix.msc2762.receive.event:m.room.message#m.text` | Read the conversation and `!ai` requests |
| `org.matrix.msc2762.receive.event:m.room.message#m.notice` | Keep earlier answers in context and see when another widget already answered |
| `org.matrix.msc2762.send.event:m.room.message#m.notice` | Post answers |

In an encrypted room, the client decrypts messages before handing them to the widget, and
it encrypts the answers. Everything stays end-to-end encrypted, and the model sees only
what your client already shows you.

## Requirements and limits

- WebGPU: current Chrome or Edge, or Firefox 141+ on Windows. On Linux, Chrome may need
  `--enable-unsafe-webgpu --enable-features=Vulkan`. A software adapter (SwiftShader) is
  far too slow to be useful.
- Element Desktop's Electron may or may not expose WebGPU; Element Web in a browser is the
  safe choice.
- Some GPU drivers reset the device when the model processes a long prompt
  (`VK_ERROR_DEVICE_LOST`; seen on a Radeon 860M with Mesa in Chrome, from about 1,000
  prompt tokens). The widget then reloads the model, retries with half the prompt size
  and remembers the size per model on that machine ("How it answers" shows it and can
  reset it). `#/?f16=0` forces the f32 builds if the f16 path misbehaves.
- Small models are small: good at summarising and pulling facts out of a short chat, weak
  at reasoning. Pick the largest model your GPU can hold.

## Security

The production build carries a CSP that allows network access only to Hugging Face (model
weights) and `raw.githubusercontent.com` (WebLLM's compiled model libraries), plus
`'wasm-unsafe-eval'` to instantiate them. Nothing else can be fetched, so room content has
no way out of the page.

## Tests

```sh
pnpm test                      # vitest: trigger parsing, transcript, prompt building
pnpm test:e2e                  # Playwright against a mock Matrix host, echo engine
HEADED=1 node test/real/webllm.mjs [model]   # real model on your GPU (after pnpm build)
```

## License

AGPL-3.0-or-later, see `LICENSE.md`.
