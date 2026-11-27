// Status bar (sync state, Sync now, layout picker) and the conflict banner.

import type { SyncStatusDto } from "../../shared/types.ts";
import { conflictInfo, originalOf } from "../../shared/conflicts.ts";
import { PRESETS, type LayoutPreset } from "../state/workspace.ts";
import { h, icons, layoutIcon, relativeTime } from "./dom.ts";

const LAYOUT_NAMES: Record<LayoutPreset, string> = {
  "1": "One pane",
  "2v": "Two side by side",
  "2h": "Two stacked",
  "3": "Three panes",
  "2x2": "Four panes",
};

export class StatusBar {
  readonly el: HTMLElement;
  private readonly dot: HTMLElement;
  private readonly label: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly syncBtn: HTMLButtonElement;
  private readonly machine: HTMLElement;
  private readonly layoutBtns = new Map<LayoutPreset, HTMLButtonElement>();
  private status: SyncStatusDto | null = null;
  private connected = true;
  private saveError: string | null = null;

  constructor(opts: { syncNow: () => void; setLayout: (l: LayoutPreset) => void }) {
    this.dot = h("span", { class: "sync-dot" });
    this.label = h("span", { class: "sync-label" });
    this.detail = h("span", { class: "sync-detail" });
    this.syncBtn = h("button", { class: "icon-btn", title: "Sync now", "aria-label": "Sync now", html: icons.sync, onclick: () => opts.syncNow() });
    this.machine = h("span", { class: "machine" });
    const layouts = h("div", { class: "layouts", role: "group", "aria-label": "Layout" });
    for (const p of PRESETS) {
      const b = h("button", { class: "icon-btn layout-btn", title: LAYOUT_NAMES[p], "aria-label": LAYOUT_NAMES[p], html: layoutIcon(p), onclick: () => opts.setLayout(p) });
      this.layoutBtns.set(p, b);
      layouts.append(b);
    }
    this.el = h(
      "footer",
      { class: "statusbar" },
      h("div", { class: "sync", "aria-live": "polite" }, this.dot, this.label, this.syncBtn, this.detail),
      h("span", { class: "spacer" }),
      layouts,
      this.machine,
    );
    setInterval(() => this.render(), 30_000);
  }

  setStatus(s: SyncStatusDto): void {
    this.status = s;
    this.render();
  }

  setConnected(c: boolean): void {
    this.connected = c;
    this.render();
  }

  setSaveError(msg: string | null): void {
    this.saveError = msg;
    this.render();
  }

  setMachine(name: string): void {
    this.machine.textContent = name;
    this.machine.title = "This machine's name in sync commits";
  }

  setLayout(l: LayoutPreset): void {
    for (const [p, b] of this.layoutBtns) b.classList.toggle("on", p === l);
  }

  private render(): void {
    const s = this.status;
    let state: string;
    let label: string;
    let detail = "";
    if (!this.connected) {
      state = "error";
      label = "Server not reachable";
      detail = "Edits are kept in this window and saved when it's back.";
    } else if (!s) {
      state = "syncing";
      label = "Connecting…";
    } else {
      state = s.state;
      const ago = s.lastSyncMs ? relativeTime(s.lastSyncMs) : "never";
      const waiting = s.ahead ? ` · ${s.ahead} change${s.ahead === 1 ? "" : "s"} waiting` : "";
      switch (s.state) {
        case "synced":
          label = `Synced ${ago}`;
          break;
        case "syncing":
          label = "Syncing…";
          break;
        case "offline":
          label = `Offline${waiting}`;
          detail = `Last synced ${ago}. Will retry automatically.`;
          break;
        case "conflict":
          label = `Synced ${ago} · ${s.conflicts.length} conflict cop${s.conflicts.length === 1 ? "y" : "ies"}`;
          break;
        case "local":
          label = "Local only";
          detail = s.message ?? "";
          break;
        case "disabled":
          label = "Sync off";
          break;
        default:
          label = `Sync problem${waiting}`;
          detail = s.message ?? "";
      }
    }
    if (s?.skipped.length && this.connected && state !== "error") {
      const names = s.skipped.map((f) => `${f.path} (${(f.size / 1048576).toFixed(1)} MB)`).join(", ");
      if (state === "synced") state = "warn";
      label += ` · ${s.skipped.length} file${s.skipped.length === 1 ? "" : "s"} not synced`;
      detail = `Over 5 MB, so kept on this device only: ${names}. Move big files out of the notes folder.`;
    }
    if (this.saveError && this.connected) {
      state = "error";
      detail = this.saveError;
    }
    this.dot.className = `sync-dot ${state}`;
    this.label.textContent = label;
    this.detail.textContent = detail;
    this.detail.title = detail;
    this.syncBtn.disabled = !this.connected || s?.state === "syncing" || s?.state === "disabled";
    this.syncBtn.classList.toggle("spinning", s?.state === "syncing");
  }
}

/** "Conflict copies need attention" strip above the panes. */
export class ConflictBanner {
  readonly el: HTMLElement;
  private readonly open: (copy: string) => void;
  private readonly titleOf: (path: string) => string | undefined;

  constructor(open: (copy: string) => void, titleOf: (path: string) => string | undefined) {
    this.open = open;
    this.titleOf = titleOf;
    this.el = h("div", { class: "banner", hidden: true, role: "region", "aria-label": "Conflicts" });
  }

  set(conflicts: string[]): void {
    this.el.hidden = conflicts.length === 0;
    if (!conflicts.length) return;
    this.el.replaceChildren(
      h("strong", {}, conflicts.length === 1 ? "A note changed in two places." : `${conflicts.length} notes changed in two places.`),
      h("span", { class: "banner-text" }, " Both versions were kept. Open one to compare and tidy up: "),
      ...conflicts.map((c) => {
        const info = conflictInfo(c);
        const title = this.titleOf(originalOf(c)) ?? shortName(c);
        return h("button", { class: "chip", title: c, onclick: () => this.open(c) }, info?.host ? `${title} (from ${info.host})` : title);
      }),
    );
  }
}

function shortName(p: string): string {
  const base = p.slice(p.lastIndexOf("/") + 1).replace(/^\d{8}-\d{6}-/, "");
  return base.replace(/\.md$/, "");
}

export { originalOf };
