import { formatMetric, describeMetric } from "./metrics.ts";
import type { Metric } from "./events.ts";

const worker = globalThis as unknown as {
  onmessage: (event: MessageEvent<{ id: number; metric: Metric }>) => void;
  postMessage: (reply: { id: number; label?: string; details?: string; error?: string }) => void;
};
worker.onmessage = ({ data: { id, metric } }) => {
  try {
    worker.postMessage({ id, label: formatMetric(metric), details: describeMetric(metric) });
  } catch {
    worker.postMessage({ id, error: "Could not count tokens" });
  }
};
