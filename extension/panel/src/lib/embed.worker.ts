// Meaning matcher, run off the main thread so the panel never freezes.
// A small embedding model (all-MiniLM-L6-v2) turns text into 384 numbers.
// It only outputs numbers: it cannot write text, so it cannot make anything up.
//
// The runtime (WebAssembly) ships inside the extension. The model weights are downloaded
// from Hugging Face the first time they are needed, then cached by the browser.
// Only the model file is fetched; no chat text is ever sent anywhere.
//
// Device: the graphics card (WebGPU) when there is one, else WebAssembly on the CPU.
import { env, pipeline } from '@huggingface/transformers';

const MODEL = 'Xenova/all-MiniLM-L6-v2';

type Device = 'webgpu' | 'wasm';
type Extractor = (texts: string[], options: { pooling: 'mean'; normalize: boolean }) => Promise<{ data: Float32Array; dims: number[] }>;
interface Job {
  id: number;
  texts: string[];
  ortBase: string;
  modelHost?: string;
  /** Force a device or precision (the question worker: WebAssembly with the indexer's model file). */
  device?: Device;
  dtype?: string;
  /** Bench page only: force a batch size. */
  batch?: number;
}

// Bench B: WebGPU fp16 106 chunks/s, fp32 85 (twice the download), q8 10.5 (its integer ops fall back
// to the CPU); WebAssembly q8 8.4. Batch size made no measurable difference on either.
const BATCH = { webgpu: 32, wasm: 8 };
const DTYPE = { webgpu: 'fp16', wasm: 'q8' };

let loaded: Promise<{ run: Extractor; device: Device }> | null = null;

async function gpuReady(): Promise<boolean> {
  try {
    return !!(await (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu?.requestAdapter());
  } catch {
    return false;
  }
}

async function open(device: Device, ortBase: string, dtype?: string): Promise<Extractor> {
  // Never load code from a CDN: use the runtime files packaged with the extension.
  // The WebGPU runtime is a different (larger) build of the same library.
  const build = device === 'webgpu' ? 'ort-wasm-simd-threaded.asyncify' : 'ort-wasm-simd-threaded';
  const wasm = env.backends.onnx.wasm!;
  wasm.wasmPaths = { mjs: `${ortBase}${build}.mjs`, wasm: `${ortBase}${build}.wasm` };
  wasm.numThreads = 1; // extension pages are not cross-origin isolated
  const run = (await pipeline('feature-extraction', MODEL, { dtype: (dtype ?? DTYPE[device]) as 'q8', device })) as unknown as Extractor;
  await run(['warm up'], { pooling: 'mean', normalize: true }); // fail here, not on the first real batch
  return run;
}

function load(job: Job): Promise<{ run: Extractor; device: Device }> {
  if (!loaded) {
    if (job.modelHost) env.remoteHost = job.modelHost; // tests point this at a local stand-in model
    (env as { useWasmCache?: boolean }).useWasmCache = false;
    env.allowLocalModels = false;
    loaded = (async () => {
      if (job.device !== 'wasm' && (job.device === 'webgpu' || (await gpuReady()))) {
        try {
          return { run: await open('webgpu', job.ortBase, job.dtype), device: 'webgpu' as const };
        } catch (err) {
          if (job.device === 'webgpu') throw err;
          console.warn('[Gutter] WebGPU unavailable for the meaning matcher, using WebAssembly:', err);
        }
      }
      try {
        return { run: await open('wasm', job.ortBase, job.dtype), device: 'wasm' as const };
      } catch (err) {
        // That model file isn't there (e.g. no fp16 copy): use the WebAssembly default.
        if (!job.dtype || job.dtype === DTYPE.wasm) throw err;
        return { run: await open('wasm', job.ortBase), device: 'wasm' as const };
      }
    })();
    loaded.catch(() => (loaded = null));
  }
  return loaded;
}

self.onmessage = async (event: MessageEvent<Job>) => {
  const job = event.data;
  try {
    const { run, device } = await load(job);
    const batch = job.batch ?? BATCH[device];
    const vectors: Float32Array[] = [];
    // Batches keep memory flat and let progress be reported.
    for (let i = 0; i < job.texts.length; i += batch) {
      const out = await run(job.texts.slice(i, i + batch), { pooling: 'mean', normalize: true });
      const width = out.dims[out.dims.length - 1];
      for (let r = 0; r * width < out.data.length; r++) vectors.push(out.data.slice(r * width, (r + 1) * width));
      self.postMessage({ id: job.id, progress: Math.min(job.texts.length, i + batch), total: job.texts.length });
    }
    self.postMessage({ id: job.id, vectors, device });
  } catch (err) {
    self.postMessage({ id: job.id, error: err instanceof Error ? err.message : String(err) });
  }
};
