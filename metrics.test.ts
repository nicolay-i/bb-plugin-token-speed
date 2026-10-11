import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEvent, countTokens, summarize, formatMetric, describeMetric, type Event, type Metric } from "./metrics.ts";

const make = (seq: number, createdAt: number, type: string, data: Event["data"], turnId = "t1"): Event =>
  ({ seq, createdAt, type, data, threadId: "thr_test", scope: { kind: "turn", turnId } });
const delta = (seq: number, time: number, text: string, turn = "t1") =>
  make(seq, time, "item/agentMessage/delta", { itemId: "m1", delta: text }, turn);

test("counts complete text, not chunks or special token markers; excludes reasoning and prefill wait", () => {
  const metrics = new Map<string, Metric>();
  applyEvent(metrics, make(1, 0, "item/started", { item: { id: "r1", type: "reasoning" } }));
  applyEvent(metrics, make(2, 5000, "item/reasoning/textDelta", { itemId: "r1", delta: "secret thinking" }));
  applyEvent(metrics, delta(3, 10000, "Hello"));
  applyEvent(metrics, delta(4, 11000, " world!"));
  applyEvent(metrics, make(5, 99000, "item/completed", { item: { id: "m1", type: "agentMessage", text: "Hello world!" } }));
  const metric = [...metrics.values()][0];
  assert.equal(metrics.size, 1);
  assert.equal(metric.elapsedMs, 1000);
  assert.equal(summarize(metric).tokens, countTokens("Hello world!"));
  assert.equal(summarize(metric).rate, countTokens("Hello world!") - countTokens("Hello"));
  assert.ok(countTokens("<|endoftext|>") > 0);
  assert.equal(formatMetric(metric), `≈ ${summarize(metric).rate!.toFixed(1)} t/s`);
  assert.ok(!formatMetric(metric).includes("tokens"));
  assert.match(describeMetric(metric), /Measured interval: 1\.00 s/);
  assert.match(describeMetric(metric), /Reasoning.*excluded/);
  assert.doesNotMatch(describeMetric(metric), /[А-Яа-яЁё]/, "User-facing information is English");
});

test("excludes a known reasoning gap; isolates reused item IDs across turns", () => {
  const metrics = new Map<string, Metric>();
  applyEvent(metrics, delta(1, 100, "Hello"));
  applyEvent(metrics, delta(2, 1100, " world"));
  applyEvent(metrics, make(3, 1200, "item/reasoning/textDelta", { itemId: "r1", delta: "thinking" }));
  applyEvent(metrics, delta(4, 100000, " again"));
  applyEvent(metrics, delta(5, 101000, "!"));
  applyEvent(metrics, delta(6, 101000, "Separate", "t2"));
  const values = [...metrics.values()];
  assert.equal(values.length, 2);
  assert.equal(values[0].elapsedMs, 2000);
  assert.equal(summarize(values[1]).rate, null);
});

test("never invents speed from a snapshot, a single chunk, equal timestamps or mismatched final text", () => {
  for (const events of [
    [make(1, 0, "item/completed", { item: { id: "m1", type: "agentMessage", text: "Snapshot" } })],
    [delta(1, 1, "One chunk")],
    [delta(1, 1, "Hello"), delta(2, 1, " world")],
    [delta(1, 1, "Hello"), delta(2, 1001, " world"), make(3, 1002, "item/completed", { item: { id: "m1", type: "agentMessage", text: "Replaced" } })],
  ]) {
    const metrics = new Map<string, Metric>();
    for (const event of events) applyEvent(metrics, event);
    assert.equal(summarize([...metrics.values()][0]).rate, null);
    assert.equal(formatMetric([...metrics.values()][0]), "— t/s");
  }
});

test("summary cache reuses tokenization and invalidates every input affecting the result", () => {
  const metrics = new Map<string, Metric>();
  applyEvent(metrics, delta(1, 100, "Hello"));
  applyEvent(metrics, delta(2, 1100, " world!"));
  const metric = [...metrics.values()][0];
  let result = summarize(metric);
  assert.strictEqual(summarize(metric), result);
  for (const change of [() => { metric.text += " Again."; }, () => { metric.firstChunk = "Hello world!"; },
    () => { metric.elapsedMs = 2000; }, () => { metric.streamMatches = false; },
    () => { metric.toolTimingUnknown = true; }]) {
    change();
    const next = summarize(metric);
    assert.notStrictEqual(next, result);
    assert.deepEqual(next, summarize({ ...metric }));
    result = next;
  }
});

test("subtracts only tool duration; longer local processes cannot lower the same generation rate", () => {
  const rates: (number | null)[] = [];
  for (const duration of [1000, 60000]) {
    const metrics = new Map<string, Metric>();
    applyEvent(metrics, delta(1, 1000, "Hello"));
    applyEvent(metrics, make(2, 2000, "item/started", { item: { id: "cmd", type: "commandExecution" } }));
    applyEvent(metrics, make(3, 2000 + duration, "item/completed", { item: { id: "cmd", type: "commandExecution" } }));
    applyEvent(metrics, delta(4, 3000 + duration, " world!"));
    const metric = [...metrics.values()][0];
    assert.equal(metric.elapsedMs, 2000);
    assert.equal(metric.toolExcludedMs, duration);
    rates.push(summarize(metric).rate);
  }
  assert.ok(rates[0] !== null);
  assert.equal(rates[0], rates[1]);
});

test("nested and parallel tools subtract their union, with turn/parent isolation", () => {
  const metrics = new Map<string, Metric>();
  applyEvent(metrics, delta(1, 1000, "Hello"));
  for (const [seq, time, type, id] of [[2, 2000, "item/started", "outer"], [3, 3000, "item/started", "inner"],
    [4, 6000, "item/completed", "outer"], [5, 8000, "item/completed", "inner"]] as const) {
    applyEvent(metrics, make(seq, time, type, { item: { id, type: "toolCall" } }));
  }
  applyEvent(metrics, make(6, 8500, "item/completed", { item: { id: "other-turn", type: "toolCall" } }, "t2"));
  applyEvent(metrics, make(7, 9000, "item/completed", { item: { id: "child", type: "toolCall", parentToolCallId: "parent" } }));
  applyEvent(metrics, delta(8, 10000, " world!"));
  const metric = [...metrics.values()][0];
  assert.equal(metric.toolExcludedMs, 6000);
  assert.equal(metric.elapsedMs, 3000);
  assert.ok(summarize(metric).rate !== null);
});

test("reasoning and overlapping tool time are never subtracted twice", () => {
  const metrics = new Map<string, Metric>();
  applyEvent(metrics, delta(1, 1000, "Hello"));
  applyEvent(metrics, make(2, 2000, "item/started", { item: { id: "cmd", type: "commandExecution" } }));
  applyEvent(metrics, make(3, 3000, "item/reasoning/textDelta", { itemId: "r", delta: "hidden" }));
  applyEvent(metrics, make(4, 6000, "item/completed", { item: { id: "cmd", type: "commandExecution" } }));
  applyEvent(metrics, delta(5, 10000, " world"));
  applyEvent(metrics, delta(6, 11000, "!"));
  const metric = [...metrics.values()][0];
  assert.equal(metric.elapsedMs, 1000);
  assert.equal(metric.toolExcludedMs, 4000);
});

test("incomplete or concurrent tool timing never produces an invented rate", () => {
  for (const started of [true, false]) {
    const metrics = new Map<string, Metric>();
    applyEvent(metrics, delta(1, 1000, "Hello"));
    applyEvent(metrics, make(2, 2000, started ? "item/started" : "item/completed", { item: { id: "cmd", type: "commandExecution" } }));
    applyEvent(metrics, delta(3, 3000, " world!"));
    const metric = [...metrics.values()][0];
    assert.equal(metric.toolTimingUnknown, true);
    assert.equal(summarize(metric).rate, null);
    assert.match(describeMetric(metric), /Rate unavailable:.*tool timing/);
    assert.doesNotMatch(describeMetric(metric), /[А-Яа-яЁё]/);
  }
});

test("turn completion seals commentary without adding later process time", () => {
  const metrics = new Map<string, Metric>();
  applyEvent(metrics, delta(1, 1000, "Hello"));
  applyEvent(metrics, delta(2, 1100, " world!"));
  applyEvent(metrics, make(3, 1200, "item/started", { item: { id: "cmd", type: "commandExecution" } }));
  applyEvent(metrics, make(4, 61200, "item/completed", { item: { id: "cmd", type: "commandExecution" } }));
  applyEvent(metrics, make(5, 63000, "turn/completed", {}));
  const metric = [...metrics.values()][0];
  assert.equal(metric.completed, true);
  assert.equal(metric.elapsedMs, 100);
  assert.equal(metric.toolExcludedMs, 0, "The process was outside the measured text interval");
  assert.ok(summarize(metric).rate !== null);
});
