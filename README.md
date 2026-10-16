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

## Shortcuts

After the trigger, a shortcut gives the model a fixed, specific instruction; small models
follow those much better than free-form requests. Send the request **as a reply** to make
that message the one it works on.

| Shortcut | Does |
|---|---|
| `!ai sum [n]` | summarise the conversation (the last *n* messages) |
| `!ai catchup` | what happened since your last message |
| `!ai decisions` | the decisions taken |
| `!ai todo` | action items with owner and due date |
| `!ai questions` | questions nobody answered |
| `!ai notes` | meeting notes: topics, decisions, next steps |
| `!ai schedule` | find a date that suits everyone |
| `!ai mood` | the tone of the discussion |
| `!ai email [to whom]` / `!ai announce` | turn the discussion into an email / announcement |
| `!ai ideas <topic>` | brainstorm |
| `!ai tldr` | two-sentence summary of a message |
| `!ai tr <language> [text]` | translate (`tr en`, `tr German`) |
| `!ai fix [text]` | correct spelling and grammar |
| `!ai rewrite <polite\|short\|formal\|casual\|simple\|clear> [text]` | rewrite in another style |
| `!ai explain [term]` | explain a term, or the message replied to |
| `!ai reply [how]` | draft a reply to a message |
| `!ai transcribe` | write out a voice message (Whisper, no LLM needed) |
| `!ai read` | the text of an image (OCR), PDF or text file (no LLM needed) |
| `!ai help` | post this list (no model needed) |

- **Which message they work on.** Commands that work on a message (`tldr`, `tr`, `fix`,
  `rewrite`, `reply`) take, in this order: the message you reply to, text after the
  command, or the message just before the request. They leave the rest of the
  conversation out of the prompt, which keeps them fast.
- **Extra words set the focus.** Words after other commands narrow what the model looks
  at: `!ai sum the budget`.
- **A question mark keeps it a question.** A request that ends in `?` stays a free
  question even if it starts with a command word.
- **Free questions sent as a reply** get the replied-to message as their subject too.

## Voice messages, images and documents

Reply to an attachment and the widget reads it **in the browser**:

| Attachment | How it is read | Runs on |
|---|---|---|
| Voice message, audio | Whisper via Transformers.js: base (0.1 GB), small (0.3 GB) or large-v3-turbo (1 GB) | CPU (base, small) or GPU (turbo) |
| Image | Tesseract.js with German and English data | CPU |
| PDF | pdf.js text layer (scanned PDFs without text come out empty) | CPU |
| Text file | as is | – |

- **Commands on attachments.** `transcribe` and `read` post the text as it is. Any other
  request sent as a reply works on that text, for example `!ai sum` on a PDF or
  `!ai tr en` on a voice message.
- **Language.** Whisper gets the room's language (German or English, guessed from recent
  messages). The small models otherwise misdetect short messages and translate them
  into nonsense.
- **Encrypted rooms.** The client hands over the ciphertext, and the widget checks its
  SHA-256 and decrypts it with the file key from the event, as clients do.
- **Long texts.** Documents and transcripts longer than about 5,000 characters are
  summarised part by part (up to 8 parts, one model call each), and the request is
  answered from those summaries. With search on, a question gets the most relevant parts
  instead.

## Search

"Search older messages and long documents" (off by default) loads multilingual-e5-small
(about 120 MB, CPU). With it on, a free question also gets the six older messages most
related to it, beyond the recent window, and questions about long documents get their
most relevant parts instead of a digest.

## Read aloud

Every answer has a **read aloud** button. Piper voices (German: Thorsten or Kerstin;
English: two voices) synthesise speech on the CPU, so they don't compete with the LLM
for the GPU. "Automatic" picks a German or English voice by the text. Voices download
on first use, about 60 MB each, and are cached in the browser.

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
  `de.datanauten.llm_widget` marker, so other instances recognise model output and never
  answer it.
- **Models:** a curated list of WebLLM builds, from SmolLM2 360M (0.4 GB, for testing)
  through Qwen 3.5 2B/4B and Gemma 4 E2B to Llama 3.1 8B. GPUs without the `shader-f16` extension get the larger `q4f32` builds
  automatically. Reasoning output (`<think>…</think>`) is stripped before posting.

## Widgets in the room and donations

At the top, the widget shows how many widgets are open in the room, how many have a model
loaded, and how many can answer *you*: yours, or someone else's that answers everyone.
Expand it to see each one and the table of what each member has donated to the room.

Every widget announces itself with a `de.datanauten.llm_widget.presence` timeline event:

- **When it opens.** That announcement asks the others to announce themselves too, so the
  count is right within a few seconds.
- **When its model or "answer everyone" setting changes,** and after each answer it posts.
- **Every 10 minutes while open.** An announcement older than 21 minutes no longer counts.
- **When the page closes,** with `online: false`. This is best effort; the 21 minutes cover
  closes where it doesn't get through.

Clients don't render this event type. In an encrypted room it is encrypted like any message.

A donation is an answer posted to the room. Private questions don't count, because they're
your own. For each answer, the widget counts:

- the tokens the model read, including the parts of a long prompt read in rounds
- the tokens it wrote
- how long the model worked on it

Each answer also carries these numbers in its `de.datanauten.llm_widget` field.

Each browser keeps its own totals per room and includes them in its announcements; a
member's total is the sum over their devices. Two limits follow from that:

- **Totals can be edited.** Nothing stops a member from inflating their own numbers in
  their browser.
- **Closed widgets eventually drop out.** A member whose widget has been closed for a while
  disappears from the table once their last announcement scrolls out of the room history
  the client returns.

## Capabilities requested

| Capability | Why |
|---|---|
| `io.element.requires_client` | Useless outside a client; hides the pop-out button |
| `org.matrix.msc2762.receive.event:m.room.message#m.text` | Read the conversation and `!ai` requests |
| `org.matrix.msc2762.receive.event:m.room.message#m.notice` | Keep earlier answers in context and see when another widget already answered |
| `org.matrix.msc2762.send.event:m.room.message#m.notice` | Post answers |
| `org.matrix.msc2762.receive.event:m.room.message#m.audio` | See voice messages and audio, to transcribe them when asked |
| `org.matrix.msc2762.receive.event:m.room.message#m.image` | See images, for OCR when asked |
| `org.matrix.msc2762.receive.event:m.room.message#m.file` | See files (PDF, text), to read them when asked |
| `org.matrix.msc4039.download_file` | Download an attachment when someone asks about it |
| `org.matrix.msc2762.send.event:de.datanauten.llm_widget.presence` | Announce that this widget is open, its model, and what it has donated |
| `org.matrix.msc2762.receive.event:de.datanauten.llm_widget.presence` | Count the other open widgets and show everyone's donations |

In an encrypted room, the client decrypts messages before handing them to the widget, and
it encrypts the answers. Everything stays end-to-end encrypted, and the model sees only
what your client already shows you.

## Requirements and limits

- WebGPU: current Chrome or Edge, or Firefox 141+ on Windows. On Linux, Chrome may need
  `--enable-unsafe-webgpu --enable-features=Vulkan`. A software adapter (SwiftShader) is
  far too slow to be useful.
- Element Desktop's Electron may or may not expose WebGPU; Element Web in a browser is the
  safe choice.
- Some GPU drivers reset the device when the model processes a long prompt in one
  pass (`VK_ERROR_DEVICE_LOST`; seen on a Radeon 860M with Mesa in Chrome, from a few
  hundred to ~1,000 prompt tokens depending on model size). The widget then reloads the
  model and feeds long prompts in rounds: each part is acknowledged with "OK" while
  WebLLM keeps its KV cache, so no single pass exceeds the part size. The part size
  halves per reset and is remembered per model on that machine ("How it answers" shows
  it and can reset it). `#/?f16=0` forces the f32 builds.
- Small models are small: good at summarising and pulling facts out of a short chat, weak
  at reasoning. Pick the largest model your GPU can hold.

## Security

The production build carries a CSP that allows network access only to Hugging Face (model
weights) and `raw.githubusercontent.com` (WebLLM's compiled model libraries), plus
`'wasm-unsafe-eval'` to instantiate them. Nothing else can be fetched, so room content has
no way out of the page.

The WebAssembly runtimes for ONNX Runtime, Piper and Tesseract, and Tesseract's language
data, are copied from `node_modules` into `public/vendor/` by `scripts/vendor.mjs`
before every dev run and build. The widget serves them itself, without public CDNs
(which the CSP would block anyway). This adds about 90 MB to `dist/`; a browser
downloads a file only when a feature first needs it.

## Tests

```sh
pnpm test                      # vitest: trigger parsing, transcript, prompt building
pnpm test:e2e                  # Playwright against a mock Matrix host, echo engine
HEADED=1 node test/real/webllm.mjs [model]   # real model on your GPU (after pnpm build)
HEADED=1 node test/real/media.mjs <dir> [model]  # OCR, PDF, Whisper, search, read aloud
                               # <dir> holds scan.png, plan.pdf, voice.ogg
```

## License

AGPL-3.0-or-later, see `LICENSE.md`.
