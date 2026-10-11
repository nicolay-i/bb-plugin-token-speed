import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { mountMessageUi } from "./message-ui.ts";
import { formatMetric, describeMetric, type Metric } from "./metrics.ts";

const metric: Metric = { text: "Hello world!", firstChunk: "Hello", lastAt: 1100,
  elapsedMs: 1000, paused: false, completed: true, streamMatches: true, turnId: "t1", parent: "root" };

function fixture(present: Parameters<typeof mountMessageUi>[2] = value => ({ label: formatMetric(value), details: describeMetric(value) }),
  value: Metric = metric) {
  const dom = new JSDOM(`<div data-timeline-row-id="message-1"><div data-message-column>
    <p>Message text</p><div class="relative"><div class="absolute">
      <button aria-label="Copy message">Copy</button>
      <button id="more" aria-haspopup="menu">…</button>
    </div></div>
  </div></div>`);
  const document = dom.window.document;
  const style = document.createElement("style");
  style.textContent = readFileSync(new URL("./app.css", import.meta.url), "utf8");
  document.head.append(style);
  return { dom, document, ui: mountMessageUi(document, (id) => id === "message-1" ? value : undefined, present) };
}

test("rate and info marker reuse the native action reveal, with no visible summary by default", () => {
  const { dom, document, ui } = fixture();
  ui.render();
  ui.render();
  const label = document.querySelector<HTMLElement>("[data-token-speed]")!;
  assert.equal(document.querySelectorAll("[data-token-speed]").length, 1);
  const control = label.parentElement!;
  assert.equal(control.parentElement?.className, "absolute");
  assert.equal(control.querySelector("[data-token-speed-info]")?.textContent, "ⓘ");
  assert.equal(document.querySelector<HTMLElement>("[role=tooltip]")!.hidden, true);
  assert.equal(label.dataset.bbPlugin, "token-speed", "Native utility classes use the plugin CSS scope");
  assert.match(label.textContent!, /^≈ [\d.]+ t\/s$/);
  for (const nativeClass of ["opacity-0", "transition-opacity", "group-hover/message:opacity-100", "group-focus-within/message:opacity-100", "[@media(hover:none)]:opacity-100"]) {
    assert.ok(control.classList.contains(nativeClass), `Uses BB's native reveal class: ${nativeClass}`);
  }
  assert.ok(!readFileSync(new URL("./app.css", import.meta.url), "utf8").includes(":hover"), "No separate hover behavior");
  assert.equal(document.querySelector("[popover]"), null);
  assert.equal(document.querySelector("[data-token-speed-summary]"), null);
  assert.equal(document.querySelector("p")?.textContent, "Message text");
  ui.dispose();
  assert.equal(document.querySelector("[data-token-speed]"), null);
  dom.window.close();
});

test("details appear on info hover or focus; Escape dismisses them and native menus stay untouched", () => {
  const { dom, document, ui } = fixture();
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-labelledby", "more");
  menu.innerHTML = '<button role="menuitem">Copy link</button><button role="menuitem">Fork into new thread</button><div>Today 14:30</div>';
  document.body.append(menu);
  const originalMenu = menu.innerHTML;
  ui.render();
  const info = document.querySelector<HTMLButtonElement>("[data-token-speed-info]")!;
  const tooltip = document.querySelector<HTMLElement>("[role=tooltip]")!;
  info.dispatchEvent(new dom.window.MouseEvent("mouseenter"));
  assert.equal(tooltip.hidden, false);
  assert.equal(info.getAttribute("aria-describedby"), tooltip.id);
  assert.match(tooltip.textContent!, /Visible output: ≈ \d+ tokens/);
  assert.match(tooltip.textContent!, /Reasoning.*excluded/);
  assert.equal(info.getAttribute("aria-label"), "Token speed information");
  assert.doesNotMatch(tooltip.textContent!, /[А-Яа-яЁё]/);
  document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal(tooltip.hidden, true);
  assert.equal(info.hasAttribute("aria-describedby"), false);
  info.focus();
  assert.equal(tooltip.hidden, false, "Keyboard focus exposes the same information");
  ui.render();
  assert.equal(menu.innerHTML, originalMenu, "Dropdown and context menu contents are not modified");
  ui.dispose();
  assert.equal(document.querySelector("[role=tooltip]"), null);
  assert.equal(document.querySelector("[data-token-speed]"), null);
  dom.window.close();
});

test("tooltip closes after leaving, survives its hover gap, and is removed on navigation or disposal", async () => {
  const { dom, document, ui } = fixture();
  ui.render();
  const info = document.querySelector<HTMLElement>("[data-token-speed-info]")!;
  const tooltip = document.querySelector<HTMLElement>("[role=tooltip]")!;
  info.dispatchEvent(new dom.window.MouseEvent("mouseenter"));
  info.dispatchEvent(new dom.window.MouseEvent("mouseleave"));
  tooltip.dispatchEvent(new dom.window.MouseEvent("mouseenter"));
  await new Promise(resolve => setTimeout(resolve, 140));
  assert.equal(tooltip.hidden, false, "Pointer can move from the marker to read the tooltip");
  tooltip.dispatchEvent(new dom.window.Event("scroll"));
  assert.equal(tooltip.hidden, false, "Scrolling long tooltip contents must not dismiss them");
  tooltip.dispatchEvent(new dom.window.MouseEvent("mouseleave"));
  await new Promise(resolve => setTimeout(resolve, 140));
  assert.equal(tooltip.hidden, true);
  info.dispatchEvent(new dom.window.MouseEvent("mouseenter"));
  document.querySelector("[data-timeline-row-id]")!.remove();
  ui.render();
  assert.equal(tooltip.hidden, true);
  ui.dispose();
  dom.window.close();
});

test("loading and failure messages are English", async () => {
  const { dom, document, ui } = fixture(() => Promise.reject(new Error("Worker unavailable")));
  ui.render();
  document.querySelector<HTMLButtonElement>("[data-token-speed-info]")!.focus();
  const tooltip = document.querySelector<HTMLElement>("[role=tooltip]")!;
  assert.equal(tooltip.textContent, "Counting visible tokens…");
  await Promise.resolve();
  assert.equal(tooltip.textContent, "Could not count tokens.");
  assert.equal(document.querySelector("[data-token-speed]")!.textContent, "— t/s");
  ui.dispose();
  dom.window.close();
});

test("asynchronous tokenization ignores stale replies and never resurrects disposed UI", async () => {
  const value = { ...metric };
  const requests: { text: string; resolve: (result: { label: string; details: string }) => void }[] = [];
  const { dom, document, ui } = fixture(snapshot => new Promise(resolve => {
    requests.push({ text: snapshot.text, resolve });
  }), value);
  ui.render();
  assert.equal(document.querySelector("[data-token-speed]")!.textContent, "… t/s");
  value.text += " New output.";
  ui.render();
  assert.equal(requests[0].text, metric.text, "Worker requests contain immutable text snapshots");
  requests[1].resolve({ label: "≈ 2.0 t/s", details: "new" });
  await Promise.resolve();
  requests[0].resolve({ label: "≈ 1.0 t/s", details: "old" });
  await Promise.resolve();
  assert.equal(document.querySelector("[data-token-speed]")!.textContent, "≈ 2.0 t/s");
  value.text += " Later output.";
  ui.render();
  ui.dispose();
  requests[2].resolve({ label: "≈ 3.0 t/s", details: "late" });
  await Promise.resolve();
  assert.equal(document.querySelector("[data-token-speed]"), null);
  dom.window.close();
});
