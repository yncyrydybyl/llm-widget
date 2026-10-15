// Inference runs here, off the main thread, so the widget UI and the
// postMessage channel to the host stay responsive while the GPU is busy.
import { WebWorkerMLCEngineHandler } from "@mlc-ai/web-llm";

// WebLLM reports a lost device only as "[object GPUDeviceLostInfo]"; log the
// reason and any uncaptured WebGPU error so a crash can be diagnosed.
const requestDevice = GPUAdapter.prototype.requestDevice;
GPUAdapter.prototype.requestDevice = async function (this: GPUAdapter, desc?: GPUDeviceDescriptor) {
    const device = await requestDevice.call(this, desc);
    void device.lost.then((info) => console.error(`WebGPU device lost (${info.reason}): ${info.message}`));
    device.addEventListener("uncapturederror", (e) =>
        console.error(`WebGPU error: ${(e as GPUUncapturedErrorEvent).error.message}`),
    );
    return device;
};

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg: MessageEvent) => handler.onmessage(msg);
