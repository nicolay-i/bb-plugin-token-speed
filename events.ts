export interface Event {
  seq: number;
  threadId: string;
  createdAt: number;
  type: string;
  scope: { kind: string; turnId?: string };
  data: {
    itemId?: string;
    delta?: string;
    parentToolCallId?: string;
    item?: { id: string; type: string; text?: string; parentToolCallId?: string };
  };
}

export interface Metric {
  text: string;
  firstChunk: string;
  lastAt: number | null;
  elapsedMs: number;
  paused: boolean;
  completed: boolean;
  streamMatches: boolean;
  turnId: string;
  parent: string;
  finalTextKnown?: boolean;
  toolExcludedMs?: number;
  toolTimingUnknown?: boolean;
  activeTools?: Set<string>;
  toolBusySince?: number;
  pendingToolMs?: number;
}

export function applyEvent(metrics: Map<string, Metric>, event: Event, onlyRowId?: string): void {
  const { data, scope } = event;
  const turnId = scope.turnId;
  if (!turnId || !Number.isFinite(event.createdAt)) return;
  const parent = data.parentToolCallId ?? data.item?.parentToolCallId ?? "root";

  // Pi may omit item/completed for commentary; turn completion seals those streams too.
  if (event.type === "turn/completed") {
    for (const [id, metric] of metrics) {
      if ((!onlyRowId || id === onlyRowId) && metric.turnId === turnId) metric.completed = true;
    }
    return;
  }

  // Reasoning itself is never tokenized. Its known intervals do not count as text streaming time.
  if (event.type.startsWith("item/reasoning/") ||
      (event.type === "item/started" && data.item?.type === "reasoning")) {
    for (const [id, metric] of metrics) {
      if ((!onlyRowId || id === onlyRowId) && metric.turnId === turnId && metric.parent === parent && !metric.completed) metric.paused = true;
    }
    return;
  }
  // Any non-text lifecycle is work, not visible token generation. Track the union of
  // nested/parallel calls in this turn and parent; neither their outputs nor other flows count.
  const item = data.item;
  const tool = item && !["agentMessage", "plan", "reasoning"].includes(item.type) &&
    (event.type === "item/started" || event.type === "item/completed");
  if (tool) {
    for (const [id, metric] of metrics) {
      if ((onlyRowId && id !== onlyRowId) || metric.turnId !== turnId || metric.parent !== parent ||
          metric.completed || metric.lastAt === null) continue;
      const active = metric.activeTools ??= new Set();
      if (event.type === "item/started") {
        if (!active.size) metric.toolBusySince = Math.max(metric.lastAt, event.createdAt);
        active.add(item.id);
      } else if (active.delete(item.id)) {
        if (!active.size && metric.toolBusySince !== undefined) {
          metric.pendingToolMs = (metric.pendingToolMs ?? 0) + Math.max(0, event.createdAt - metric.toolBusySince);
          metric.toolBusySince = undefined;
        }
      } else {
        // An end without a captured start cannot safely be assigned a duration.
        metric.toolTimingUnknown = true;
      }
    }
    return;
  }
  const delta = event.type === "item/agentMessage/delta" || event.type === "item/plan/delta";
  const final = event.type === "item/completed" && ["agentMessage", "plan"].includes(data.item?.type ?? "");
  if (!delta && !final) return;
  const itemId = delta ? data.itemId : data.item?.id;
  if (!itemId) return;
  // BB's timeline DOM uses this identity; no imports from private BB packages.
  const id = `${event.threadId}:assistant:kind:assistant|turn:${turnId}|parent:${parent}|item:${itemId}`;
  if (onlyRowId && id !== onlyRowId) return;
  let metric = metrics.get(id);
  if (!metric) {
    metric = { text: "", firstChunk: "", lastAt: null, elapsedMs: 0, paused: false,
      completed: false, streamMatches: true, turnId, parent };
    metrics.set(id, metric);
  }
  if (delta && typeof data.delta === "string" && data.delta.length && !metric.completed) {
    if (metric.lastAt !== null) {
      const gap = Math.max(0, event.createdAt - metric.lastAt);
      const openToolMs = metric.toolBusySince === undefined ? 0 : Math.max(0, event.createdAt - metric.toolBusySince);
      const toolMs = Math.min(gap, (metric.pendingToolMs ?? 0) + openToolMs);
      // Text delivered while work is still running could be buffered or genuinely concurrent.
      // Subtracting the work but retaining those tokens would invent an inflated rate.
      if (openToolMs > 0) metric.toolTimingUnknown = true;
      metric.toolExcludedMs = (metric.toolExcludedMs ?? 0) + toolMs;
      if (!metric.paused) metric.elapsedMs += gap - toolMs;
    }
    metric.pendingToolMs = 0;
    if (metric.activeTools?.size) metric.toolBusySince = event.createdAt;
    if (metric.lastAt === null) metric.firstChunk = data.delta;
    metric.text += data.delta;
    metric.lastAt = event.createdAt;
    metric.paused = false;
  }
  if (final && typeof data.item?.text === "string") {
    metric.streamMatches = metric.text === data.item.text;
    metric.text = data.item.text;
    metric.completed = true;
    metric.finalTextKnown = true;
  }
}
