// Inference runs here, off the main thread, so the widget UI and the
// postMessage channel to the host stay responsive while the GPU is busy.
import { WebWorkerMLCEngineHandler } from "@mlc-ai/web-llm";

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg: MessageEvent) => handler.onmessage(msg);
