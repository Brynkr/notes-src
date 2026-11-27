// Left column: new note, search box, note list (or search results).

import { MARK_END, MARK_START, type NoteMeta, type SearchHit } from "../../shared/types.ts";
import { api } from "../api.ts";
import { h, icons, modKey, relativeTime } from "./dom.ts";

export interface SidebarDeps {
  showTrash: () => void;
  today: () => void;
  open: (path: string, toSide: boolean) => void;
  create: (title: string) => Promise<void>;
  collapse: () => void;
}

export class Sidebar {
  readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private readonly searchInput: HTMLInputElement;
  private readonly newForm: HTMLFormElement;
  private readonly newInput: HTMLInputElement;
  private readonly countEl: HTMLElement;
  private notes: NoteMeta[] = [];
  private hits: SearchHit[] | null = null;
  private activePath: string | null = null;
  private cursor = -1;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private searchSeq = 0;
  private readonly deps: SidebarDeps;

  constructor(deps: SidebarDeps) {
    this.deps = deps;
    this.searchInput = h("input", {
      type: "search",
      class: "search-input",
      placeholder: "Search notes",
      "aria-label": "Search notes",
      spellcheck: "false",
      oninput: () => this.onSearchInput(),
      onkeydown: (e: KeyboardEvent) => this.onSearchKey(e),
    });
    this.newInput = h("input", {
      type: "text",
      class: "new-input",
      placeholder: "Title for the new note",
      "aria-label": "New note title",
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === "Escape") this.hideNew();
      },
      onblur: () => setTimeout(() => this.hideNew(), 150),
    });
    this.newForm = h(
      "form",
      {
        class: "new-form",
        hidden: true,
        onsubmit: async (e: Event) => {
          e.preventDefault();
          const title = this.newInput.value;
          this.hideNew();
          await this.deps.create(title);
        },
      },
      this.newInput,
    );
    this.list = h("div", { class: "note-list", role: "listbox", "aria-label": "Notes" });
    this.countEl = h("span", { class: "note-count" });
    this.el = h(
      "aside",
      { class: "sidebar", "aria-label": "Notes sidebar" },
      h(
        "div",
        { class: "sidebar-head" },
        h("span", { class: "brand" }, "Notes"),
        this.countEl,
        h("button", { class: "icon-btn", title: "Today's note (Alt+D)", "aria-label": "Today's note", html: icons.today, onclick: () => this.deps.today() }),
        h("button", { class: "icon-btn", title: "Trash", "aria-label": "Trash", html: icons.trash, onclick: () => this.deps.showTrash() }),
        h("button", { class: "icon-btn", title: `New note (Alt+N)`, "aria-label": "New note", html: icons.plus, onclick: () => this.showNew() }),
        h("button", { class: "icon-btn hide-wide", title: "Hide sidebar", "aria-label": "Hide sidebar", html: icons.sidebar, onclick: () => this.deps.collapse() }),
      ),
      h("div", { class: "search-wrap" }, h("span", { class: "search-icon", html: icons.search }), this.searchInput),
      this.newForm,
      this.list,
      h("div", { class: "sidebar-foot" }, `${modKey}+P go to note · ${modKey}+K search`),
    );
  }

  setNotes(notes: NoteMeta[]): void {
    this.notes = notes;
    this.countEl.textContent = String(notes.length);
    if (this.hits === null) this.render();
    else this.runSearch(); // results may have changed
  }

  setActivePath(path: string | null): void {
    this.activePath = path;
    for (const el of this.list.querySelectorAll<HTMLElement>("[data-path]")) {
      el.classList.toggle("active", el.dataset.path === path);
      el.setAttribute("aria-selected", String(el.dataset.path === path));
    }
  }

  focusSearch(): void {
    this.searchInput.focus();
    this.searchInput.select();
  }

  showNew(): void {
    this.newForm.hidden = false;
    this.newInput.value = "";
    this.newInput.focus();
  }

  private hideNew(): void {
    this.newForm.hidden = true;
  }

  private onSearchInput(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.runSearch(), 120);
  }

  private async runSearch(): Promise<void> {
    const q = this.searchInput.value.trim();
    const seq = ++this.searchSeq;
    if (!q) {
      this.hits = null;
      this.cursor = -1;
      this.render();
      return;
    }
    try {
      const hits = await api.search(q);
      if (seq !== this.searchSeq) return; // a newer query is in flight
      this.hits = hits;
      this.cursor = hits.length ? 0 : -1;
      this.render();
    } catch {
      /* offline: keep previous results */
    }
  }

  private onSearchKey(e: KeyboardEvent): void {
    const items = [...this.list.querySelectorAll<HTMLElement>("[data-path]")];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!items.length) return;
      this.cursor = (this.cursor + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items.forEach((el, i) => el.classList.toggle("cursor", i === this.cursor));
      items[this.cursor].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      const el = items[Math.max(0, this.cursor)];
      if (el?.dataset.path) this.deps.open(el.dataset.path, e.metaKey || e.ctrlKey);
    } else if (e.key === "Escape") {
      this.searchInput.value = "";
      void this.runSearch();
    }
  }

  private item(path: string, title: string, sub: Node | string, conflict: boolean): HTMLElement {
    return h(
      "button",
      {
        class: `note-item${path === this.activePath ? " active" : ""}${conflict ? " is-conflict" : ""}`,
        role: "option",
        "aria-selected": String(path === this.activePath),
        "data-path": path,
        title: path,
        onclick: (e: MouseEvent) => this.deps.open(path, e.metaKey || e.ctrlKey),
        onauxclick: (e: MouseEvent) => {
          if (e.button === 1) this.deps.open(path, true);
        },
      },
      h("span", { class: "note-title" }, title, conflict ? h("span", { class: "badge" }, "conflict") : null),
      h("span", { class: "note-sub" }, sub),
    );
  }

  render(): void {
    this.list.replaceChildren();
    if (this.hits !== null) {
      if (!this.hits.length) {
        this.list.append(h("p", { class: "list-empty" }, "No matches."));
        return;
      }
      const byPath = new Map(this.notes.map((n) => [n.path, n]));
      this.hits.forEach((hit, i) => {
        const el = this.item(hit.path, hit.title, renderSnippet(hit.snippet), byPath.get(hit.path)?.conflict ?? false);
        if (i === this.cursor) el.classList.add("cursor");
        this.list.append(el);
      });
      return;
    }
    if (!this.notes.length) {
      this.list.append(h("p", { class: "list-empty" }, "No notes yet. Press + to write your first one."));
      return;
    }
    for (const n of this.notes) {
      const folder = n.path.includes("/") ? n.path.slice(0, n.path.lastIndexOf("/")) + " · " : "";
      this.list.append(this.item(n.path, n.title, folder + relativeTime(n.modifiedMs), n.conflict));
    }
  }
}

/** Snippet text comes from note content: escape it, then turn the markers into <mark>. */
function renderSnippet(s: string): Node {
  const frag = document.createDocumentFragment();
  const parts = s.split(new RegExp(`(${MARK_START}[^${MARK_END}]*${MARK_END})`));
  for (const part of parts) {
    if (part.startsWith(MARK_START)) frag.append(h("mark", {}, part.slice(1, -1)));
    else if (part) frag.append(part.replace(/\s+/g, " "));
  }
  return frag;
}
