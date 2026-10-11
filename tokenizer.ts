import source from "./worker-source.generated.ts";
import type { Metric } from "./events.ts";

export type Presentation = { label: string; details: string };

export function createTokenizer() {
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  let worker: Worker;
  try { worker = new Worker(url); }
  catch (error) { URL.revokeObjectURL(url); throw error; }
  let sequence = 0;
  let failure: Error | null = null;
  const pending = new Map<number, { resolve: (value: Presentation) => void; reject: (error: Error) => void }>();
  function fail(error: Error) {
    URL.revokeObjectURL(url);
    failure = error;
    for (const task of pending.values()) task.reject(error);
    pending.clear();
  }
  worker.onmessage = ({ data }: MessageEvent<Presentation & { id: number; error?: string }>) => {
    // Release only after the worker has loaded its blob (also safe in WebKit).
    URL.revokeObjectURL(url);
    const task = pending.get(data.id);
    if (!task) return;
    pending.delete(data.id);
    if (data.error) task.reject(new Error(data.error));
    else task.resolve({ label: data.label, details: data.details });
  };
  worker.onerror = () => fail(new Error("Could not start the tokenizer"));
  worker.onmessageerror = () => fail(new Error("Could not read the tokenizer response"));
  return {
    present(metric: Metric): Promise<Presentation> {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        try { worker.postMessage({ id, metric }); }
        catch { pending.delete(id); reject(new Error("Could not send text to the tokenizer")); }
      });
    },
    dispose() {
      worker.terminate();
      fail(new Error("Tokenizer stopped"));
    },
  };
}
