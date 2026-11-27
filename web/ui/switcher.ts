// Quick switcher (Ctrl/Cmd+P): fuzzy-find a note by title and open it, or
// create a note with the typed title.

import { fuzzyRank } from "../../shared/fuzzy.ts";
import type { NoteMeta } from "../../shared/types.ts";
import { h, modKey, relativeTime } from "./dom.ts";

export interface SwitcherDeps {
  notes: () => NoteMeta[];
  open: (path: string, toSide: boolean) => void;
  create: (title: string, toSide: boolean) => void;
  /** Called when the switcher closes without opening anything, to restore focus. */
  cancel: () => void;
}

interface Row {
  kind: "note" | "create";
  path?: string;
  title: string;
  positions?: number[];
  sub: string;
}

export class QuickSwitcher {
  readonly el: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly list: HTMLElement;
  private rows: Row[] = [];
  private cursor = 0;
  private readonly deps: SwitcherDeps;

  constructor(deps: SwitcherDeps) {
    this.deps = deps;
    this.input = h("input", {
      class: "switcher-input",
      type: "text",
      placeholder: "Go to note…",
      "aria-label": "Go to note",
      spellcheck: "false",
      autocomplete: "off",
      oninput: () => this.update(),
      onkeydown: (e: KeyboardEvent) => this.onKey(e),
    });
    this.list = h("div", { class: "switcher-list", role: "listbox" });
    const panel = h(
      "div",
      { class: "switcher", role: "dialog", "aria-label": "Quick switcher" },
      this.input,
      this.list,
      h("div", { class: "switcher-foot" }, `Enter open · ${modKey}+Enter open to the side · Shift+Enter new note · Esc close`),
    );
    this.el = h("div", {
      class: "switcher-backdrop",
      hidden: true,
      onmousedown: (e: MouseEvent) => {
        if (e.target === this.el) this.close(true);
      },
    }, panel);
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  show(): void {
    this.el.hidden = false;
    this.input.value = "";
    this.update();
    this.input.focus();
  }

  close(cancelled: boolean): void {
    if (this.el.hidden) return;
    this.el.hidden = true;
    if (cancelled) this.deps.cancel();
  }

  private update(): void {
    const q = this.input.value.trim();
    const notes = this.deps.notes();
    if (!q) {
      this.rows = notes.slice(0, 50).map((n) => ({ kind: "note", path: n.path, title: n.title, sub: relativeTime(n.modifiedMs) }));
    } else {
      const ranked = fuzzyRank(q, notes, (n) => n.title, (n) => n.modifiedMs, 50);
      this.rows = ranked.map((r) => ({
        kind: "note",
        path: r.item.path,
        title: r.item.title,
        positions: r.match.positions,
        sub: relativeTime(r.item.modifiedMs),
      }));
      const exact = notes.some((n) => n.title.trim().toLowerCase() === q.toLowerCase());
      if (!exact) this.rows.push({ kind: "create", title: q, sub: "New note" });
    }
    this.cursor = 0;
    this.render();
  }

  private render(): void {
    this.list.replaceChildren(
      ...this.rows.map((r, i) =>
        h(
          "button",
          {
            class: `switcher-row${i === this.cursor ? " cursor" : ""}${r.kind === "create" ? " create" : ""}`,
            role: "option",
            "aria-selected": String(i === this.cursor),
            onmousemove: () => this.setCursor(i),
            onclick: (e: MouseEvent) => this.choose(i, e.metaKey || e.ctrlKey, false),
          },
          h("span", { class: "switcher-title" }, r.kind === "create" ? `Create “${r.title}”` : highlight(r.title, r.positions)),
          h("span", { class: "switcher-sub" }, r.sub),
        ),
      ),
    );
    if (!this.rows.length) this.list.append(h("p", { class: "list-empty" }, "No notes yet."));
  }

  private setCursor(i: number): void {
    if (i === this.cursor) return;
    this.cursor = i;
    [...this.list.children].forEach((el, j) => el.classList.toggle("cursor", j === i));
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!this.rows.length) return;
      this.setCursor((this.cursor + (e.key === "ArrowDown" ? 1 : -1) + this.rows.length) % this.rows.length);
      this.list.children[this.cursor]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      this.choose(this.cursor, e.metaKey || e.ctrlKey, e.shiftKey);
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.close(true);
    }
  }

  private choose(i: number, toSide: boolean, forceCreate: boolean): void {
    const q = this.input.value.trim();
    const row = this.rows[i];
    this.close(false);
    if (forceCreate && q) return this.deps.create(q, toSide);
    if (!row) {
      if (q) this.deps.create(q, toSide);
      return;
    }
    if (row.kind === "create") this.deps.create(row.title, toSide);
    else if (row.path) this.deps.open(row.path, toSide);
  }
}

function highlight(text: string, positions: number[] = []): Node {
  const frag = document.createDocumentFragment();
  const set = new Set(positions);
  let run = "";
  let runMarked = false;
  const flush = () => {
    if (!run) return;
    frag.append(runMarked ? h("b", {}, run) : run);
    run = "";
  };
  let offset = 0;
  for (const ch of text) {
    // Iterate by code point so emoji are never split across elements.
    const marked = set.has(offset);
    if (marked !== runMarked) {
      flush();
      runMarked = marked;
    }
    run += ch;
    offset += ch.length;
  }
  flush();
  return frag;
}
