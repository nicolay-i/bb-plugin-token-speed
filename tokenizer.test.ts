import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import source from "./worker-source.generated.ts";
import { formatMetric, describeMetric, type Metric } from "./metrics.ts";

test("bundled worker preserves token counts and leaves the caller's event loop responsive", async () => {
  const metric: Metric = { text: "Hello world!", firstChunk: "Hello", lastAt: 1100, elapsedMs: 1000,
    paused: false, completed: true, streamMatches: true, turnId: "t1", parent: "root" };
  const values = [metric, { ...metric, text: "Длинный ответ с кодом и Markdown. ".repeat(2000) }];
  const expected = values.map(value => ({ label: formatMetric(value), details: describeMetric(value) }));
  const worker = new Worker(`const { parentPort } = require('node:worker_threads');
    globalThis.postMessage = value => parentPort.postMessage(value);
    parentPort.on('message', data => globalThis.onmessage({ data }));\n${source}`, { eval: true });
  let timerRan = false;
  const timer = setTimeout(() => { timerRan = true; }, 0);
  try {
    const replies = await new Promise<Map<number, { label: string; details: string }>>((resolve, reject) => {
      const messages = new Map();
      worker.on("error", reject);
      worker.on("message", reply => {
        assert.equal(reply.error, undefined);
        messages.set(reply.id, { label: reply.label, details: reply.details });
        if (messages.size === values.length) resolve(messages);
      });
      values.forEach((value, id) => worker.postMessage({ id, metric: value }));
    });
    assert.ok(timerRan, "Tokenization does not block the caller's timer");
    for (const [id, reply] of replies) assert.deepEqual(reply, expected[id]);
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
});
