import { useEffect } from "react";
import { definePluginApp, useSdk, type PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import { mountMessageUi } from "./message-ui";
import { createTokenizer } from "./tokenizer";
import { createThreadMetrics, getMetric, updateThreadMetrics, type ThreadMetrics } from "./thread-metrics";
import "./app.css";

// Hooks supply the public SDK client; the content script owns all DOM changes and cleanup.
let sdk: PluginBrowserBbSdk | null = null;
function Client() {
  const client = useSdk();
  useEffect(() => {
    sdk = client;
    return () => { if (sdk === client) sdk = null; };
  }, [client]);
  return null;
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "sdk-client", component: Client });
  app.contentScripts.register({
    id: "message-speed",
    mount({ signal }) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      const threads = new Map<string, ThreadMetrics>();
      const tokenizer = createTokenizer();
      const ui = mountMessageUi(document, (rowId) => getMetric(threads.get(rowId.split(":")[0]), rowId),
        tokenizer.present, scheduleRender);
      let running = false;
      let frame: number | null = null;
      let lastMissingRow: string | undefined;
      let lastMountedThreads = "";
      function scheduleRender() {
        if (frame !== null || signal.aborted) return;
        frame = window.requestAnimationFrame(() => {
          frame = null;
          if (signal.aborted) return;
          ui.render();
          // Fetch newly mounted messages immediately; existing streams keep their 1 Hz polling.
          const rows = [...document.querySelectorAll<HTMLElement>("[data-timeline-row-id]")];
          const mounted = [...new Set(rows.map(row => /^([^:]+):assistant:/.exec(row.dataset.timelineRowId ?? "")?.[1])
            .filter(Boolean))].sort().join("|");
          const missing = rows.find(row => {
            const rowId = row.dataset.timelineRowId ?? "";
            const threadId = /^([^:]+):assistant:/.exec(rowId)?.[1];
            return threadId && !getMetric(threads.get(threadId), rowId);
          })?.dataset.timelineRowId;
          if (!running && (mounted !== lastMountedThreads || missing !== lastMissingRow)) {
            lastMissingRow = missing;
            lastMountedThreads = mounted;
            if (mounted) void update();
          }
        });
      }
      const observer = new MutationObserver(scheduleRender);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true,
        attributeFilter: ["data-state", "aria-expanded", "aria-labelledby", "data-timeline-row-id"] });

      async function update() {
        if (running || !sdk || signal.aborted) return;
        running = true;
        try {
          const visible = new Map<string, Set<string>>();
          for (const row of document.querySelectorAll<HTMLElement>("[data-timeline-row-id]")) {
            const rowId = row.dataset.timelineRowId ?? "";
            const id = /^([^:]+):assistant:/.exec(rowId)?.[1];
            if (!id) continue;
            if (!visible.has(id)) visible.set(id, new Set());
            visible.get(id)!.add(rowId);
          }
          for (const [threadId, rowIds] of visible) {
            let state = threads.get(threadId);
            if (!state) {
              state = createThreadMetrics();
            }
            // Touch the cache entry; only mounted threads are ever polled.
            threads.delete(threadId);
            threads.set(threadId, state);
            try {
              await updateThreadMetrics(sdk.threads, threadId, rowIds, state, controller.signal, scheduleRender);
            } catch (error) {
              if (!signal.aborted) console.warn("[token-speed] Could not read events", threadId, error);
            }
            if (signal.aborted) return;
          }
          // ponytail: count-bounded cache; add a byte budget if deeply scrolled histories dominate memory.
          // Keep eight recently viewed threads, plus any additional currently mounted panes.
          for (const id of threads.keys()) {
            if (threads.size <= 8) break;
            if (!visible.has(id)) threads.delete(id);
          }
          scheduleRender();
        } catch (error) {
          if (!signal.aborted) console.warn("[token-speed] Could not read events", error);
        } finally {
          running = false;
        }
      }
      const timer = window.setInterval(() => { void update(); }, 1000);
      void update();
      return () => {
        controller.abort();
        signal.removeEventListener("abort", abort);
        window.clearInterval(timer);
        observer.disconnect();
        if (frame !== null) window.cancelAnimationFrame(frame);
        ui.dispose();
        tokenizer.dispose();
        threads.clear();
      };
    },
  });
});
