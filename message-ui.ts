import type { Metric } from "./events.ts";
import type { Presentation } from "./tokenizer.ts";

/** DOM enhancement only: keep BB's action reveal and leave native menus unchanged. */
export function mountMessageUi(document: Document, getMetric: (rowId: string) => Metric | undefined,
  present: (metric: Metric) => Presentation | Promise<Presentation>, onChange?: () => void) {
  const owned = new Set<HTMLElement>();
  const captions = new WeakMap<Metric, { text: string; firstChunk: string; lastAt: number | null;
    elapsedMs: number; streamMatches: boolean; toolExcludedMs: number; toolTimingUnknown: boolean; label: string; details: string }>();
  let disposed = false;
  let activeInfo: HTMLElement | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const tooltip = document.createElement("div");
  tooltip.id = "token-speed-tooltip";
  tooltip.dataset.bbPlugin = "token-speed";
  tooltip.dataset.tokenSpeedTooltip = "";
  tooltip.className = "token-speed-tooltip rounded-md bg-primary text-primary-foreground shadow-md";
  tooltip.setAttribute("role", "tooltip");
  tooltip.hidden = true;
  document.body.append(tooltip);
  owned.add(tooltip);

  function hideTooltip() {
    clearTimeout(closeTimer);
    activeInfo?.removeAttribute("aria-describedby");
    activeInfo = null;
    tooltip.hidden = true;
  }
  function showTooltip(info: HTMLElement) {
    const rowId = info.closest<HTMLElement>("[data-timeline-row-id]")?.dataset.timelineRowId;
    const metric = rowId ? getMetric(rowId) : undefined;
    if (!metric) return;
    hideTooltip();
    activeInfo = info;
    info.setAttribute("aria-describedby", tooltip.id);
    tooltip.textContent = presentation(metric).details;
    tooltip.hidden = false;
    const anchor = info.getBoundingClientRect();
    const width = document.defaultView!.innerWidth;
    const height = document.defaultView!.innerHeight;
    tooltip.style.left = `${Math.max(8, Math.min(anchor.right - tooltip.offsetWidth, width - tooltip.offsetWidth - 8))}px`;
    const top = anchor.top >= tooltip.offsetHeight + 12 ? anchor.top - tooltip.offsetHeight - 4 : anchor.bottom + 4;
    tooltip.style.top = `${Math.max(8, Math.min(top, height - tooltip.offsetHeight - 8))}px`;
  }
  function scheduleClose() {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      if (activeInfo && document.activeElement !== activeInfo && !activeInfo.matches(":hover") && !tooltip.matches(":hover")) hideTooltip();
    }, 120);
  }
  tooltip.addEventListener("mouseenter", () => clearTimeout(closeTimer));
  tooltip.addEventListener("mouseleave", scheduleClose);
  function onKey(event: KeyboardEvent) { if (event.key === "Escape") hideTooltip(); }
  function onScroll(event: Event) { if (!tooltip.contains(event.target as Node)) hideTooltip(); }
  document.addEventListener("keydown", onKey);
  document.addEventListener("scroll", onScroll, true);
  document.defaultView?.addEventListener("resize", hideTooltip);

  function presentation(metric: Metric) {
    let cached = captions.get(metric);
    if (!cached || cached.text !== metric.text || cached.firstChunk !== metric.firstChunk || cached.lastAt !== metric.lastAt ||
        cached.elapsedMs !== metric.elapsedMs || cached.streamMatches !== metric.streamMatches ||
        cached.toolExcludedMs !== (metric.toolExcludedMs ?? 0) || cached.toolTimingUnknown !== Boolean(metric.toolTimingUnknown)) {
      cached = { text: metric.text, firstChunk: metric.firstChunk, lastAt: metric.lastAt,
        elapsedMs: metric.elapsedMs, streamMatches: metric.streamMatches,
        toolExcludedMs: metric.toolExcludedMs ?? 0, toolTimingUnknown: Boolean(metric.toolTimingUnknown),
        label: "… t/s", details: "Counting visible tokens…" };
      captions.set(metric, cached);
      const current = cached;
      const result = present({ ...metric });
      if ("then" in result) {
        const publish = (value: Presentation) => {
          Object.assign(current, value);
          if (!disposed && captions.get(metric) === current) (onChange ?? render)();
        };
        void result.then(publish, () => publish({ label: "— t/s", details: "Could not count tokens." }));
      } else Object.assign(current, result);
    }
    return cached;
  }

  function render() {
    if (disposed) return;
    for (const row of document.querySelectorAll<HTMLElement>("[data-timeline-row-id]")) {
      const metric = getMetric(row.dataset.timelineRowId ?? "");
      if (!metric?.text) continue;
      const column = [...row.querySelectorAll<HTMLElement>("[data-message-column]")]
        .find((node) => node.closest("[data-timeline-row-id]") === row);
      if (!column) continue;
      const actions = column.querySelector<HTMLElement>(":scope > .relative > .absolute") ??
        column.querySelector<HTMLElement>('button[aria-haspopup="menu"]')?.parentElement;
      if (!actions) continue;
      let label = actions.querySelector<HTMLElement>(":scope > [data-token-speed-control] > [data-token-speed]");
      if (!label) {
        label = document.createElement("span");
        label.dataset.tokenSpeed = "";
        label.dataset.bbPlugin = "token-speed";
        label.className = "token-speed-action";
        const control = document.createElement("span");
        control.dataset.bbPlugin = "token-speed";
        control.dataset.tokenSpeedControl = "";
        control.className = "token-speed-control text-muted-foreground opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100 [@media(hover:none)]:opacity-100";
        const info = document.createElement("button");
        info.type = "button";
        info.dataset.tokenSpeedInfo = "";
        info.className = "token-speed-info";
        info.textContent = "ⓘ";
        info.setAttribute("aria-label", "Token speed information");
        info.addEventListener("mouseenter", () => showTooltip(info));
        info.addEventListener("focus", () => showTooltip(info));
        info.addEventListener("mouseleave", scheduleClose);
        info.addEventListener("blur", scheduleClose);
        control.append(label, info);
        actions.append(control);
        owned.add(control);
      }
      const text = presentation(metric).label;
      if (label.textContent !== text) label.textContent = text;
    }

    if (activeInfo) {
      const rowId = activeInfo.closest<HTMLElement>("[data-timeline-row-id]")?.dataset.timelineRowId;
      const metric = rowId ? getMetric(rowId) : undefined;
      if (!activeInfo.isConnected || !metric?.text) hideTooltip();
      else {
        const text = presentation(metric).details;
        if (tooltip.textContent !== text) showTooltip(activeInfo);
      }
    }
    for (const node of owned) if (!node.isConnected) owned.delete(node);
  }

  return {
    render,
    dispose() {
      disposed = true;
      hideTooltip();
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
      document.defaultView?.removeEventListener("resize", hideTooltip);
      for (const node of owned) node.remove();
      owned.clear();
    },
  };
}
