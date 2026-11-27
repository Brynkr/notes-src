// Note history: versions recorded by sync commits, each shown as the changes
// restoring it would make to the current text. Restoring is a normal edit
// (Ctrl/Cmd+Z undoes it) that saves and syncs like any other.

import type { HistoryEntry } from "../../shared/types.ts";
import { lineDiff } from "../../shared/diff.ts";
import { api } from "../api.ts";
import { h, icons, relativeTime } from "./dom.ts";

export interface HistoryTarget {
  path: string;
  title: string;
  current: () => string;
  restore: (text: string) => void;
}

export class HistoryDialog {
  readonly el: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly list: HTMLElement;
  private readonly preview: HTMLElement;
  private readonly restoreBtn: HTMLButtonElement;
  private target: HistoryTarget | null = null;
  private entries: HistoryEntry[] = [];
  private selected = -1;
  private selectedText: string | null = null;
  private seq = 0;
  private readonly onClosed: () => void;

  constructor(opts: { onClosed: () => void }) {
    this.onClosed = opts.onClosed;
    this.titleEl = h("h2", {}, "History");
    this.list = h("div", { class: "history-list", role: "listbox", "aria-label": "Versions" });
    this.preview = h("div", { class: "history-preview" });
    this.restoreBtn = h("button", { type: "button", class: "btn btn-primary", disabled: true, onclick: () => this.restore() }, "Restore this version");
    const panel = h(
      "div",
      {
        class: "dialog dialog-wide",
        role: "dialog",
        "aria-label": "Note history",
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === "Escape") this.close();
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            this.select(Math.max(0, Math.min(this.entries.length - 1, this.selected + (e.key === "ArrowDown" ? 1 : -1))));
          }
        },
      },
      h("header", { class: "dialog-head" }, this.titleEl, h("button", { type: "button", class: "icon-btn", "aria-label": "Close", html: icons.close, onclick: () => this.close() })),
      h("div", { class: "history-body" }, this.list, this.preview),
      h(
        "footer",
        { class: "dialog-foot" },
        h("span", { class: "dialog-status history-legend" }, h("span", { class: "diff-add" }, "+ comes back"), " ", h("span", { class: "diff-del" }, "− goes away"), " if you restore"),
        h("span", { class: "spacer" }),
        h("button", { type: "button", class: "btn", onclick: () => this.close() }, "Close"),
        this.restoreBtn,
      ),
    );
    this.el = h("div", { class: "dialog-backdrop", hidden: true, onmousedown: (e: MouseEvent) => e.target === this.el && this.close() }, panel);
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  async show(target: HistoryTarget): Promise<void> {
    this.target = target;
    this.el.hidden = false;
    this.titleEl.textContent = `History of “${target.title}”`;
    this.entries = [];
    this.selected = -1;
    this.restoreBtn.disabled = true;
    this.list.replaceChildren(h("p", { class: "muted" }, "Loading…"));
    this.preview.replaceChildren();
    try {
      this.entries = await api.history(target.path);
    } catch (err) {
      this.list.replaceChildren(h("p", { class: "bad" }, (err as Error).message));
      return;
    }
    if (!this.entries.length) {
      this.list.replaceChildren(h("p", { class: "list-empty" }, "No saved versions yet. Versions are recorded each time this note syncs."));
      return;
    }
    this.list.replaceChildren(
      ...this.entries.map((e, i) =>
        h(
          "button",
          { type: "button", class: "history-row", role: "option", onclick: () => this.select(i) },
          h("span", { class: "note-title" }, new Date(e.timeMs).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })),
          h("span", { class: "note-sub" }, `${relativeTime(e.timeMs)}${e.machine ? ` · ${e.machine}` : ""}${e.file.startsWith(".trash/") || e.file.includes("/.trash/") ? " · in Trash" : ""}`),
        ),
      ),
    );
    this.select(0);
    (this.list.firstElementChild as HTMLElement | null)?.focus();
  }

  close(): void {
    if (this.el.hidden) return;
    this.el.hidden = true;
    this.target = null;
    this.onClosed();
  }

  private async select(i: number): Promise<void> {
    if (!this.target || i < 0 || i >= this.entries.length) return;
    this.selected = i;
    [...this.list.children].forEach((el, j) => {
      el.classList.toggle("cursor", j === i);
      el.setAttribute("aria-selected", String(j === i));
    });
    (this.list.children[i] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
    const seq = ++this.seq;
    this.restoreBtn.disabled = true;
    this.selectedText = null;
    this.preview.replaceChildren(h("p", { class: "muted" }, "Loading…"));
    try {
      const e = this.entries[i];
      const { text } = await api.historyVersion(e.commit, e.file);
      if (seq !== this.seq || !this.target) return;
      this.selectedText = text;
      const current = this.target.current();
      this.restoreBtn.disabled = text === current;
      this.preview.replaceChildren(text === current ? h("p", { class: "muted" }, "Same as the note is now.") : renderDiff(current, text));
    } catch (err) {
      if (seq === this.seq) this.preview.replaceChildren(h("p", { class: "bad" }, (err as Error).message));
    }
  }

  private restore(): void {
    if (!this.target || this.selectedText === null) return;
    this.target.restore(this.selectedText);
    this.close();
  }
}

// --- line diff -------------------------------------------------------------------

export function renderDiff(current: string, version: string): HTMLElement {
  const ops = lineDiff(current, version);
  const out = h("div", { class: "diff" });
  const CONTEXT = 3;
  const changed = ops.map((o) => o.kind !== "same");
  const near = (i: number) => changed.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some(Boolean);
  let skipped = 0;
  const flushSkip = () => {
    if (skipped) out.append(h("div", { class: "diff-skip" }, `… ${skipped} unchanged line${skipped === 1 ? "" : "s"} …`));
    skipped = 0;
  };
  ops.forEach((o, i) => {
    if (o.kind === "same" && !near(i)) {
      skipped++;
      return;
    }
    flushSkip();
    const sign = o.kind === "add" ? "+" : o.kind === "del" ? "−" : " ";
    out.append(h("div", { class: `diff-line diff-${o.kind}` }, h("span", { class: "diff-sign" }, sign), o.line || " "));
  });
  flushSkip();
  return out;
}
