// Tiny DOM helpers. Text is always set with textContent (never innerHTML),
// except for the fixed icon strings below.

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (k === "html") el.innerHTML = String(v); // trusted icon markup only
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export function relativeTime(ms: number, now = Date.now()): string {
  const s = Math.round((now - ms) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr} h ago`;
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
export const modKey = isMac ? "⌘" : "Ctrl";

/** 16px stroke icons. */
const svg = (d: string) =>
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

export const icons = {
  plus: svg('<path d="M8 3v10M3 8h10"/>'),
  close: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
  split: svg('<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M8 3v10"/>'),
  trash: svg('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>'),
  sync: svg('<path d="M13 8a5 5 0 0 1-8.5 3.5M3 8a5 5 0 0 1 8.5-3.5"/><path d="M11.5 1.8v2.7H8.8M4.5 14.2v-2.7h2.7"/>'),
  sidebar: svg('<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M6 3v10"/>'),
  search: svg('<circle cx="7" cy="7" r="4.25"/><path d="M10.2 10.2L13.5 13.5"/>'),
  history: svg('<path d="M2.8 8a5.2 5.2 0 1 0 1.5-3.7"/><path d="M2.5 2.5v2.8h2.8M8 5v3.2l2.2 1.4"/>'),
  today: svg('<rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/><circle cx="8" cy="10" r="1.1" fill="currentColor" stroke="none"/>'),
  minus: svg('<path d="M3 8h10"/>'),
  palette: svg('<path d="M8 1.8a6.2 6.2 0 1 0 0 12.4c1 0 1.4-.6 1.4-1.3 0-.9-.8-1.2-.8-2 0-.8.6-1.3 1.4-1.3h1.4a2.8 2.8 0 0 0 2.8-2.8C14.2 4.2 11.4 1.8 8 1.8z"/><circle cx="4.9" cy="7.4" r=".9" fill="currentColor" stroke="none"/><circle cx="6.6" cy="4.7" r=".9" fill="currentColor" stroke="none"/><circle cx="9.8" cy="4.6" r=".9" fill="currentColor" stroke="none"/>'),
  gear: svg('<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7L3.6 3.6"/>'),
};

/** Mini diagrams for the layout picker. */
export const layoutIcons: Record<string, string> = {
  "1": '<rect x="1.5" y="2.5" width="15" height="11" rx="1.5"/>',
  "2v": '<rect x="1.5" y="2.5" width="15" height="11" rx="1.5"/><path d="M9 2.5v11"/>',
  "2h": '<rect x="1.5" y="2.5" width="15" height="11" rx="1.5"/><path d="M1.5 8h15"/>',
  "3": '<rect x="1.5" y="2.5" width="15" height="11" rx="1.5"/><path d="M9 2.5v11M9 8h7.5"/>',
  "2x2": '<rect x="1.5" y="2.5" width="15" height="11" rx="1.5"/><path d="M9 2.5v11M1.5 8h15"/>',
};

export function layoutIcon(preset: string): string {
  return `<svg width="18" height="16" viewBox="0 0 18 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">${layoutIcons[preset]}</svg>`;
}

// --- toasts ----------------------------------------------------------------

export interface ToastAction {
  label: string;
  run: () => void;
}

let toastRoot: HTMLElement | null = null;

export function toast(message: string, kind: "info" | "warn" | "error" = "info", actions: ToastAction[] = [], ms = 7000): void {
  if (!toastRoot) {
    toastRoot = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
    document.body.append(toastRoot);
  }
  const close = () => el.remove();
  const el = h(
    "div",
    { class: `toast toast-${kind}` },
    h("span", { class: "toast-msg" }, message),
    ...actions.map((a) =>
      h("button", { class: "toast-action", onclick: () => (a.run(), close()) }, a.label),
    ),
    h("button", { class: "icon-btn toast-close", "aria-label": "Dismiss", html: icons.close, onclick: close }),
  );
  toastRoot.append(el);
  if (ms > 0) setTimeout(close, ms);
}
