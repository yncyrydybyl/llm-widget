# In-browser AI options (researched 2026-10-16)

Candidates for extending the widget. Versions were checked on npm and Hugging Face. Speeds
on a Radeon 860M iGPU are estimates; "unverified" marks claims without a primary source.

## Constraints of running inside Element

- **No Chrome built-in AI in the widget.** Element frames widgets with
  `allow="microphone; camera; encrypted-media; autoplay; display-capture; clipboard-write; clipboard-read"`.
  The Prompt, Summarizer and Translator APIs need `language-model` and friends, which
  default to same-origin, so they are blocked in the widget iframe. The microphone is
  allowed, so speech-to-text works.
- **WASM runs single-threaded.** Element sends no COOP/COEP headers, so the widget is not
  cross-origin isolated and has no SharedArrayBuffer. That slows every WASM engine:
  wllama, Tesseract, Piper and onnxruntime-web.
- **One large WebGPU model at a time.** Keep auxiliary models on WASM so they don't compete
  with the LLM for the GPU.

## LLM

| Option | Notes |
|---|---|
| **WebLLM 0.2.86 (in use)**: Qwen3.5-2B (2.2 GB), Qwen3.5-4B (3.9 GB), gemma-4-E2B-it (3.4 GB) | Already in the prebuilt list and now in the widget. Built with a 4k context, raisable with `context_window_size`. Gemma 4 E2B also takes audio input. |
| Transformers.js 4.3 (`onnx-community/Qwen3.5-2B-ONNX-OPT`, q4f16 1.6 GB) | The choice if vision and audio should come from the same library. |
| wllama 3.8 (GGUF, WebGPU + WASM) | CPU fallback when the GPU resets. Files must be at most 2 GB, so larger models need splitting. |
| MediaPipe LLM Inference | In maintenance; Google points to LiteRT-LM instead. Not recommended. |

## Text-to-speech (German needed)

| Option | Notes |
|---|---|
| **Piper** via `@mintplex-labs/piper-tts-web` | German voices (thorsten, kerstin, eva_k), about 60 MB per voice, WASM, faster than real time. Licences vary per voice. |
| Kyutai Pocket TTS (ONNX) | German plus voice cloning, about 146 MB per language. No official npm package (unverified). |
| Kokoro (`kokoro-js`), Kitten TTS, Supertonic 2 | Good quality, but no German. |
| Web Speech `speechSynthesis` | Depends on the operating system's voices; on Linux usually espeak. |

## Speech-to-text

| Option | Notes |
|---|---|
| **Whisper large-v3-turbo** (Transformers.js, WebGPU, about 1.5 GB), or its German fine-tune | Good German. |
| whisper-small / whisper-base | Lighter, but German gets worse. |
| Gemma 4 E2B audio input | Already in WebLLM; transcribes and understands in one model. |
| Voice-activity detection: `@ricky0123/vad-web` | For hands-free input. |

## OCR and documents

| Option | Notes |
|---|---|
| **pdf.js** (`pdfjs-dist`) | Text from text-based PDFs; no model needed. |
| tesseract.js 7 with `deu` | Robust, slow when single-threaded. |
| granite-docling-258M (ONNX) | Turns page images into markdown and tables. |
| PaddleOCR.js (PP-OCRv5) | Faster and more accurate detection. |
| Qwen3-VL-2B / Florence-2 | Questions about an image or screenshot. |

## Other

- **Embeddings for search over room history:** `Xenova/multilingual-e5-small` (120 MB),
  or EmbeddingGemma 2 (542 MB). Retrieving only the relevant messages keeps prompts short,
  which also avoids the GPU resets.
- **Translation:** the LLM itself, or `Xenova/opus-mt-de-en` / `opus-mt-en-de`. NLLB is
  non-commercial.
- **Background removal:** BiRefNet_lite (MIT). RMBG is non-commercial.
- **Image generation:** `web-txt2img` (SD-Turbo, about 2 GB). Likely to reset this GPU;
  lowest priority.
- **Sentiment, named entities, music:** multilingual-sentiment-analysis,
  bert-base-multilingual NER, musicgen-small (non-commercial).

## Suggested order

1. Newer WebLLM models (done).
2. Retrieval over room history with embeddings.
3. Piper German text-to-speech.
4. Whisper, or Gemma 4 audio, for voice messages.
5. pdf.js, then OCR.
6. Translation, sentiment and named entities.
7. Image generation, last.
