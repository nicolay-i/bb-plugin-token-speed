import { test } from "node:test";
import assert from "node:assert/strict";
import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import { createThreadMetrics, getMetric, updateThreadMetrics } from "./thread-metrics.ts";
import { summarize, describeMetric, type Event } from "./metrics.ts";

type Threads = PluginBrowserBbSdk["threads"];
const signal = new AbortController().signal;
const threadId = "thr_other";
const id = (item: string) => `${threadId}:assistant:kind:assistant|turn:t1|parent:root|item:${item}`;
const row = (item: string, start: number, text = "Hello world!") => ({
  id: id(item), kind: "conversation", role: "assistant", turnId: "t1", sourceSeqStart: start, text,
});
const event = (seq: number, item: string, text: string, final = false): Event => ({
  seq, createdAt: seq * 100, threadId, scope: { kind: "turn", turnId: "t1" },
  type: final ? "item/completed" : "item/agentMessage/delta",
  data: final ? { item: { id: item, type: "agentMessage", text } } : { itemId: item, delta: text },
});
function fixture(rows: ReturnType<typeof row>[], events: Event[]) {
  const calls: { threadId: string; afterSeq: string; limit: string }[] = [];
  const timeline = async () => ({ rows, timelinePage: { olderCursor: null } });
  const threads = { timeline, events: { list: async (args: typeof calls[number]) => {
    calls.push(args);
    assert.equal(args.limit, "100");
    return events.filter(e => e.seq > Number(args.afterSeq)).slice(0, 100);
  } } } as unknown as Threads;
  return { threads, calls };
}

test("large histories start at the displayed message, not event zero; newest messages have priority", async () => {
  const state = createThreadMetrics();
  const { threads, calls } = fixture([row("old", 200), row("latest", 16700)], [
    event(200, "old", "Hello"), event(201, "old", " world!"), event(202, "old", "Hello world!", true),
    event(16700, "latest", "Hello"), event(16701, "latest", " world!"), event(16702, "latest", "Hello world!", true),
  ]);
  await updateThreadMetrics(threads, threadId, new Set([id("old"), id("latest")]), state, signal);
  assert.equal(calls[0].afterSeq, "16699");
  assert.equal(calls[1].afterSeq, "199");
  assert.ok(summarize(getMetric(state, id("latest"))!).rate !== null);
  assert.ok(summarize(getMetric(state, id("old"))!).rate !== null);
  const count = calls.length;
  await updateThreadMetrics(threads, threadId, new Set([id("old"), id("latest")]), state, signal);
  assert.equal(calls.length, count, "Completed messages do not replay their events");
});

test("message streams paginate with the API limit and never include sibling messages", async () => {
  const state = createThreadMetrics();
  const text = " hello".repeat(205);
  const events = Array.from({ length: 205 }, (_, i) => event(1000 + i, "m", " hello"));
  events.push(event(1205, "m", text, true), event(1206, "sibling", "unrelated text", true));
  const { threads, calls } = fixture([row("m", 1000, text)], events);
  await updateThreadMetrics(threads, threadId, new Set([id("m")]), state, signal);
  assert.equal(calls.length, 3);
  assert.equal(getMetric(state, id("m"))!.text, text);
  assert.ok(summarize(getMetric(state, id("m"))!).rate !== null);
  assert.equal(state.metrics.has(id("sibling")), false);
});

test("snapshot-only messages still show token statistics without inventing a speed or repeatedly fetching", async () => {
  const state = createThreadMetrics();
  const { threads, calls } = fixture([row("snapshot", 8000)], []);
  await updateThreadMetrics(threads, threadId, new Set([id("snapshot")]), state, signal);
  const metric = getMetric(state, id("snapshot"))!;
  assert.equal(metric.text, "Hello world!");
  assert.ok(summarize(metric).tokens > 0);
  assert.equal(summarize(metric).rate, null);
  assert.match(describeMetric(metric), /First-chunk tokens: N\/A/);
  assert.match(describeMetric(metric), /Measured interval: N\/A/);
  await updateThreadMetrics(threads, threadId, new Set([id("snapshot")]), state, signal);
  assert.equal(calls.length, 1);
});

test("a live message continues from its cursor when more deltas arrive", async () => {
  const state = createThreadMetrics();
  const events = [event(1000, "live", "Hello")];
  const { threads } = fixture([row("live", 1000, "Hello")], events);
  await updateThreadMetrics(threads, threadId, new Set([id("live")]), state, signal);
  assert.equal(getMetric(state, id("live"))!.text, "Hello");
  events.push(event(1001, "live", " world!"), event(1002, "live", "Hello world!", true));
  await updateThreadMetrics(threads, threadId, new Set([id("live")]), state, signal);
  assert.equal(getMetric(state, id("live"))!.text, "Hello world!");
  assert.ok(summarize(getMetric(state, id("live"))!).rate !== null);
});

test("scrolling to older messages pages the timeline index and reads only their event range", async () => {
  const state = createThreadMetrics();
  const { threads, calls } = fixture([row("new", 16000)], [event(300, "old", "Hello"),
    event(301, "old", " world!"), event(302, "old", "Hello world!", true),
    event(16000, "new", "Hello world!", true)]);
  const timelineCalls: unknown[] = [];
  threads.timeline = (async (args: Parameters<Threads["timeline"]>[0]) => {
    timelineCalls.push(args);
    return args.beforeAnchorId ? { rows: [row("old", 300)], timelinePage: { olderCursor: null } }
      : { rows: [row("new", 16000)], timelinePage: { olderCursor: { anchorId: "opaque-cursor", anchorSeq: 15000 } } };
  }) as Threads["timeline"];
  await updateThreadMetrics(threads, threadId, new Set([id("new")]), state, signal);
  await updateThreadMetrics(threads, threadId, new Set([id("old")]), state, signal);
  assert.equal(timelineCalls.length, 3);
  assert.equal(calls.at(-1)!.afterSeq, "299");
  assert.ok(summarize(getMetric(state, id("old"))!).rate !== null);
});

test("snapshots are published before event requests and unchanged timeline refreshes retain their identity", async () => {
  const state = createThreadMetrics();
  const { threads } = fixture([row("m", 1000)], [event(1000, "m", "Hello world!", true)]);
  let published = false;
  const list = threads.events.list;
  threads.events.list = args => {
    assert.ok(published, "A full snapshot is already available while events are in flight");
    return list(args);
  };
  await updateThreadMetrics(threads, threadId, new Set([id("m")]), state, signal, () => { published = true; });
  const snapshot = state.messages.get(id("m"))!.snapshot;
  await updateThreadMetrics(threads, threadId, new Set([id("m"), id("not-indexed-yet")]), state, signal);
  assert.strictEqual(state.messages.get(id("m"))!.snapshot, snapshot);
});

test("turn completion never promotes a pruned commentary prefix over the full timeline snapshot", async () => {
  const state = createThreadMetrics();
  const end: Event = { seq: 1002, createdAt: 100200, threadId, type: "turn/completed",
    scope: { kind: "turn", turnId: "t1" }, data: {} };
  const { threads } = fixture([row("m", 1000)], [event(1000, "m", "Hel"), event(1001, "m", "lo"), end]);
  await updateThreadMetrics(threads, threadId, new Set([id("m")]), state, signal);
  assert.equal(state.metrics.get(id("m"))!.completed, true);
  assert.equal(getMetric(state, id("m"))!.text, "Hello world!");
  assert.equal(summarize(getMetric(state, id("m"))!).rate, null);
});
