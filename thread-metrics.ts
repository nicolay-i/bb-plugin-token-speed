import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import { applyEvent, type Event, type Metric } from "./events.ts";

type Threads = PluginBrowserBbSdk["threads"];
type Timeline = Awaited<ReturnType<Threads["timeline"]>>;
type Row = Timeline["rows"][number];

export function createThreadMetrics() {
  return {
    metrics: new Map<string, Metric>(),
    messages: new Map<string, { start: number; snapshot: Metric }>(),
    cursors: new Map<string, number>(),
    unavailable: new Set<string>(),
    indexed: false,
    olderCursor: null as Timeline["timelinePage"]["olderCursor"],
  };
}
export type ThreadMetrics = ReturnType<typeof createThreadMetrics>;

export function getMetric(state: ThreadMetrics | undefined, rowId: string): Metric | undefined {
  const metric = state?.metrics.get(rowId);
  const snapshot = state?.messages.get(rowId)?.snapshot;
  // A partially fetched historical stream must not replace the full stored message.
  return metric?.text && (!snapshot || metric.finalTextKnown || metric.text.startsWith(snapshot.text))
    ? metric : snapshot;
}

function indexRows(state: ThreadMetrics, rows: Row[]) {
  for (const row of rows) {
    if (row.kind === "turn") {
      if (row.children) indexRows(state, row.children);
    } else if (row.kind === "conversation" && row.role === "assistant") {
      const previous = state.messages.get(row.id);
      if (previous?.start === row.sourceSeqStart && previous.snapshot.text === row.text) continue;
      state.messages.set(row.id, { start: row.sourceSeqStart, snapshot: {
        text: row.text, firstChunk: "", lastAt: null, elapsedMs: 0, paused: false,
        completed: true, streamMatches: false, turnId: row.turnId ?? "", parent: "root",
      } });
    }
  }
}

export async function updateThreadMetrics(
  threads: Threads, threadId: string, visibleIds: Set<string>, state: ThreadMetrics, signal: AbortSignal,
  onChange?: () => void,
) {
  const missing = () => [...visibleIds].some(id => !state.messages.has(id) && !state.metrics.get(id)?.completed);
  if (!state.indexed || missing()) {
    const timeline = await threads.timeline({ threadId, includeNestedRows: "true", signal });
    if (signal.aborted) return;
    indexRows(state, timeline.rows);
    onChange?.();
    if (!state.indexed) state.olderCursor = timeline.timelinePage.olderCursor;
    state.indexed = true;
    // Scrolling into older messages advances the lightweight timeline index, not the event log from zero.
    if (missing() && state.olderCursor) {
      const older = await threads.timeline({ threadId, includeNestedRows: "true", signal,
        beforeAnchorId: state.olderCursor.anchorId, beforeAnchorSeq: String(state.olderCursor.anchorSeq) });
      if (signal.aborted) return;
      indexRows(state, older.rows);
      onChange?.();
      state.olderCursor = older.timelinePage.olderCursor;
    }
  }

  // Latest mounted messages first. Three bounded event pages per tick, shared by this thread.
  let pages = 0;
  for (const rowId of [...visibleIds].reverse()) {
    const message = state.messages.get(rowId);
    if (!message || state.unavailable.has(rowId) || state.metrics.get(rowId)?.completed) continue;
    let cursor = state.cursors.get(rowId) ?? Math.max(0, message.start - 1);
    while (pages < 3) {
      const events = await threads.events.list({ threadId, afterSeq: String(cursor), order: "asc", limit: "100",
        types: ["item/agentMessage/delta", "item/plan/delta", "item/completed", "item/started",
          "item/reasoning/textDelta", "item/reasoning/summaryTextDelta", "turn/completed"], signal });
      if (signal.aborted) return;
      pages++;
      for (const event of events) {
        applyEvent(state.metrics, event as Event, rowId);
        cursor = Math.max(cursor, event.seq);
      }
      state.cursors.set(rowId, cursor);
      if (events.length) onChange?.();
      if (!events.length && !state.metrics.get(rowId)) state.unavailable.add(rowId);
      if (state.metrics.get(rowId)?.completed || events.length < 100) break;
    }
    if (pages >= 3) break;
  }
}
