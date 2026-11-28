// Left column: new note, search box, note list (or search results).

import { MARK_END, MARK_START, type NoteMeta, type SearchHit } from "../../shared/types.ts";
import { MODE_FOLDER, MODE_LABEL, MODES, pathInMode, type Mode } from "../../shared/modes.ts";
import { api } from "../api.ts";
import { makeNoteDraggable } from "./dnd.ts";
import { h, icons, modKey, relativeTime } from "./dom.ts";

export interface SidebarDeps {
  showTrash: () => void;
  today: () => void;
  open: (path: string, toSide: boolean) => void;
  create: (title: string) => Promise<void>;
  /** IDE mode: a new (empty) file at a path inside the current mode's folder. */
  createFile: (fullPath: string) => Promise<void>;
  /** IDE mode: a new folder at a full path ("Work/sensor", "@ab12cd34/src"). */
  createFolder: (fullPath: string) => Promise<void>;
  /** IDE mode: show a folder from elsewhere on this computer in the tree. */
  addOutside: (absPath: string) => Promise<void>;
  /** IDE mode's file tree and changes, shown instead of the search box and note list. */
  explorer: HTMLElement;
  collapse: () => void;
  mode: () => Mode;
  setMode: (mode: Mode) => void;
}

export class Sidebar {
  readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private readonly searchInput: HTMLInputElement;
  private readonly newForm: HTMLFormElement;
  private readonly newInput: HTMLInputElement;
  private readonly countEl: HTMLElement;
  private readonly modeButtons: HTMLButtonElement[];
  private readonly searchWrap: HTMLElement;
  private readonly footEl: HTMLElement;
  private ide = false;
  /** What the "new" box makes, and where (a full folder path ending in "/"). */
  private newKind: "note" | "file" | "folder" | "outside" = "note";
  private newBase = "";
  private blurTimer: ReturnType<typeof setTimeout> | null = null;
  private notes: NoteMeta[] = [];
  private hits: SearchHit[] | null = null;
  private activePath: string | null = null;
  private cursor = -1;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private searchSeq = 0;
  /** What the list last drew; refreshes that change nothing visible skip the rebuild. */
  private drawn = "";
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
      // Hide when focus moves elsewhere (unless the box is reopened first: see showNew).
      onblur: () => (this.blurTimer = setTimeout(() => this.hideNew(), 150)),
    });
    this.newForm = h(
      "form",
      {
        class: "new-form",
        hidden: true,
        onsubmit: async (e: Event) => {
          e.preventDefault();
          const value = this.newInput.value;
          const name = value.trim().split(String.fromCharCode(92)).join("/").replace(/^\/+/, ""); // Windows "\" → "/", no leading "/"
          const kind = this.newKind;
          this.hideNew();
          if (kind === "note") await this.deps.create(value);
          else if (!name) return;
          else if (kind === "file") await this.deps.createFile(this.newBase + name);
          else if (kind === "folder") await this.deps.createFolder(this.newBase + name);
          else await this.deps.addOutside(value.trim());
        },
      },
      this.newInput,
    );
    this.list = h("div", { class: "note-list", role: "listbox", "aria-label": "Notes" });
    this.countEl = h("span", { class: "note-count" });
    this.modeButtons = MODES.map((m) =>
      h("button", { type: "button", "data-mode": m, "aria-pressed": "false", title: `${MODE_LABEL[m]} notes (Alt+M switches)`, onclick: () => deps.setMode(m) }, MODE_LABEL[m]),
    );
    this.el = h(
      "aside",
      { class: "sidebar", "aria-label": "Notes sidebar" },
      h(
        "div",
        { class: "sidebar-head" },
        // Top-left: hide the note list (the same spot shows it again; see the top bar).
        h("button", { class: "icon-btn sidebar-hide", title: "Hide the note list", "aria-label": "Hide the note list", html: icons.sidebar, onclick: () => this.deps.collapse() }),
        h("span", { class: "brand" }, "Notes"),
        this.countEl,
        h("button", { class: "icon-btn", title: "Today's note (Alt+D)", "aria-label": "Today's note", html: icons.today, onclick: () => this.deps.today() }),
        h("button", { class: "icon-btn", title: "Trash", "aria-label": "Trash", html: icons.trash, onclick: () => this.deps.showTrash() }),
        h("button", { class: "icon-btn", title: `New note (${modKey}+N or Alt+N)`, "aria-label": "New note", html: icons.plus, onclick: () => this.showNew() }),
      ),
      h("div", { class: "segmented mode-switch", role: "group", "aria-label": "Mode" }, ...this.modeButtons),
      (this.searchWrap = h("div", { class: "search-wrap" }, h("span", { class: "search-icon", html: icons.search }), this.searchInput)),
      this.newForm,
      this.list,
      deps.explorer,
      (this.footEl = h("div", { class: "sidebar-foot" }, `${modKey}+P go to note · ${modKey}+K search`)),
    );
  }

  /** IDE mode: file tree instead of the note list; + makes a file instead of a note. */
  setIde(on: boolean): void {
    this.ide = on;
    this.el.classList.toggle("is-ide", on);
    this.searchWrap.hidden = on;
    this.list.hidden = on;
    this.countEl.hidden = on;
    this.deps.explorer.hidden = !on;
    this.footEl.textContent = on ? `${modKey}+P go to file · Ctrl+click opens to the side` : `${modKey}+P go to note · ${modKey}+K search`;

  }

  /** Show which mode is on; results from the other mode are re-queried. */
  modeChanged(): void {
    const mode = this.deps.mode();
    for (const b of this.modeButtons) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
    this.searchInput.placeholder = `Search ${MODE_LABEL[mode]}`;
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

  /**
   * Show the "new" box. In notes mode it makes a note; in IDE mode a file
   * (default), a folder, or adds an outside folder. `base` is the folder it
   * goes in (default: the current mode's folder).
   */
  showNew(kind: "file" | "folder" | "outside" | null = null, base: string | null = null): void {
    this.newKind = kind ?? (this.ide ? "file" : "note");
    this.newBase = base ?? `${MODE_FOLDER[this.deps.mode()]}/`;
    const where = this.newBase.startsWith("@") ? this.newBase.slice(10) || "this folder" : this.newBase;
    const text = {
      note: ["Title for the new note", "New note title"],
      file: [`New file in ${where}  e.g. hello.py`, "New file name"],
      folder: [`New folder in ${where}`, "New folder name"],
      outside: ["Full path of a folder, e.g. C:\code\project", "Outside folder path"],
    }[this.newKind];
    this.newInput.placeholder = text[0];
    this.newInput.setAttribute("aria-label", text[1]);
    // A pending "hide on blur" from the last use must not close the box we're opening now.
    if (this.blurTimer) clearTimeout(this.blurTimer);
    this.blurTimer = null;
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
      const hits = await api.search(q, this.deps.mode());
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
    const el = h(
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
    makeNoteDraggable(el, path); // drop it on a pane to open it there
    return el;
  }

  render(): void {
    const drawn = JSON.stringify([this.hits, this.cursor, this.activePath, this.notes.map((n) => [n.path, n.title, n.conflict, Math.floor(n.modifiedMs / 60000)])]);
    if (drawn === this.drawn && this.list.childElementCount) return;
    this.drawn = drawn;
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
      const shown = pathInMode(n.path);
      const folder = shown.includes("/") ? shown.slice(0, shown.lastIndexOf("/")) + " · " : "";
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
