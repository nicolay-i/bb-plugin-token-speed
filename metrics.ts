import { Tiktoken } from "js-tiktoken/lite";
import o200k from "js-tiktoken/ranks/o200k_base";

const encoder = new Tiktoken(o200k);
export const countTokens = (text: string) => encoder.encode(text, [], []).length;

import type { Metric } from "./events.ts";
export { applyEvent, type Event, type Metric } from "./events.ts";

const summaries = new WeakMap<Metric, { text: string; firstChunk: string; elapsedMs: number;
  streamMatches: boolean; toolTimingUnknown: boolean; result: { tokens: number; rate: number | null } }>();

export function summarize(metric: Metric) {
  const cached = summaries.get(metric);
  if (cached && cached.text === metric.text && cached.firstChunk === metric.firstChunk &&
      cached.elapsedMs === metric.elapsedMs && cached.streamMatches === metric.streamMatches &&
      cached.toolTimingUnknown === Boolean(metric.toolTimingUnknown)) return cached.result;
  const tokens = countTokens(metric.text);
  // The first chunk has no measured generation interval; do not inflate speed with it.
  const measuredTokens = Math.max(0, tokens - countTokens(metric.firstChunk));
  const rate = metric.streamMatches && !metric.toolTimingUnknown && metric.elapsedMs > 0 && measuredTokens > 0
    ? measuredTokens * 1000 / metric.elapsedMs : null;
  const result = { tokens, rate };
  summaries.set(metric, { text: metric.text, firstChunk: metric.firstChunk, elapsedMs: metric.elapsedMs,
    streamMatches: metric.streamMatches, toolTimingUnknown: Boolean(metric.toolTimingUnknown), result });
  return result;
}

export function formatMetric(metric: Metric): string {
  const { rate } = summarize(metric);
  return rate === null ? "— t/s" : `≈ ${rate.toFixed(1)} t/s`;
}

export function describeMetric(metric: Metric): string {
  const { tokens, rate } = summarize(metric);
  return [
    `Speed: ${rate === null ? "N/A (insufficient reliable stream data)" : `≈ ${rate.toFixed(1)} t/s`}`,
    `Visible output: ≈ ${tokens} tokens`,
    metric.lastAt === null ? "First-chunk tokens: N/A (no stream data)"
      : `First-chunk tokens: ≈ ${countTokens(metric.firstChunk)} (excluded from rate)`,
    metric.lastAt === null ? "Measured interval: N/A"
      : `Measured interval: ${(metric.elapsedMs / 1000).toFixed(2)} s`,
    `Tool time within text intervals: ${((metric.toolExcludedMs ?? 0) / 1000).toFixed(2)} s (excluded; overlaps counted once)`,
    ...(metric.toolTimingUnknown ? ["Rate unavailable: incomplete tool timing or text arrived during tool execution."] : []),
    "Calculation: (all tokens − first-chunk tokens) / measured text time excluding tools.",
    "Reasoning, known tool execution intervals, and waiting before the first chunk are excluded. Unmarked pauses, prefill, and delivery delays cannot be separated from generation.",
    "Tokenizer: o200k_base. This is an estimate, not model billing usage.",
  ].join("\n");
}
