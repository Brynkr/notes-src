// The main area: a CSS grid of 1-4 panes, each with a header and an editor.

import { extractTitle } from "../../shared/markdown.ts";
import { ApiError } from "../api.ts";
import { createEditor, type PaneEditor } from "../editor/cm.ts";
import type { BufferStore, NoteBuffer } from "../state/buffers.ts";
import type { PaneState, Workspace } from "../state/workspace.ts";
import { h, icons, modKey } from "./dom.ts";

const AREAS = ["a", "b", "c", "d"];

export interface PaneDeps {
  workspace: Workspace;
  buffers: BufferStore;
  deleteNote: (path: string) => Promise<void>;
  newNote: () => void;
  extraKeys: (paneId: string) => { key: string; run: () => boolean }[];
}

class Pane {
  readonly id: string;
  readonly el: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly dotEl: HTMLElement;
  private readonly body: HTMLElement;
  private readonly deleteBtn: HTMLButtonElement;
  private editor: PaneEditor | null = null;
  private buffer: NoteBuffer | null = null;
  notePath: string | null = null;
  private loadSeq = 0;
  private titleFrame = 0;
  private deleteArmed: ReturnType<typeof setTimeout> | null = null;
  private readonly deps: PaneDeps;

  constructor(id: string, deps: PaneDeps) {
    this.id = id;
    this.deps = deps;
    this.titleEl = h("span", { class: "pane-title" });
    this.dotEl = h("span", { class: "dirty-dot", "aria-hidden": "true" });
    this.deleteBtn = h("button", {
      class: "icon-btn pane-delete",
      title: "Delete note",
      "aria-label": "Delete note",
      html: icons.trash,
      onclick: () => this.onDelete(),
    });
    this.body = h("div", { class: "pane-body" });
    this.el = h(
      "section",
      { class: "pane", "data-pane": id, onpointerdown: () => deps.workspace.setActive(id) },
      h(
        "header",
        { class: "pane-head" },
        this.titleEl,
        this.dotEl,
        h("span", { class: "spacer" }),
        this.deleteBtn,
        h("button", {
          class: "icon-btn",
          title: `Open this note to the side (${modKey}+\\)`,
          "aria-label": "Split",
          html: icons.split,
          onclick: (e: Event) => {
            e.stopPropagation();
            deps.workspace.setActive(id);
            deps.workspace.openToSide(this.notePath);
          },
        }),
        h("button", {
          class: "icon-btn",
          title: "Close pane (Alt+W)",
          "aria-label": "Close pane",
          html: icons.close,
          onclick: (e: Event) => {
            e.stopPropagation();
            deps.workspace.close(id);
          },
        }),
      ),
      this.body,
    );
  }

  async show(state: PaneState): Promise<void> {
    const seq = ++this.loadSeq;
    this.notePath = state.notePath;
    this.teardown();
    if (!state.notePath) return this.showEmpty();
    this.body.replaceChildren(h("div", { class: "pane-loading" }, "Opening…"));
    let buffer: NoteBuffer;
    try {
      buffer = await this.deps.buffers.open(state.notePath);
    } catch (err) {
      if (seq !== this.loadSeq) return;
      if (err instanceof ApiError && (err.status === 404 || err.status === 400)) {
        this.deps.workspace.noteGone(state.notePath);
        return;
      }
      this.body.replaceChildren(
        h("div", { class: "pane-empty" }, h("p", {}, `Couldn't open this note: ${(err as Error).message}`), h("button", { class: "btn", onclick: () => this.show(state) }, "Try again")),
      );
      return;
    }
    if (seq !== this.loadSeq) return; // replaced while loading
    this.buffer = buffer;
    this.body.replaceChildren();
    this.editor = createEditor({
      parent: this.body,
      buffer,
      store: this.deps.buffers,
      cursor: state.cursor,
      onFocus: () => this.deps.workspace.setActive(this.id),
      onViewState: (cursor, scrollTop) => this.deps.workspace.saveView(this.id, cursor, scrollTop),
      onRefresh: () => this.refreshHeader(),
      extraKeys: this.deps.extraKeys(this.id),
    });
    const view = this.editor.view;
    requestAnimationFrame(() => {
      view.scrollDOM.scrollTop = state.scrollTop;
      if (this.deps.workspace.state.activePaneId === this.id) view.focus();
    });
    this.refreshHeader();
  }

  focus(): void {
    if (this.editor) this.editor.view.focus();
    else this.el.querySelector<HTMLElement>(".pane-empty button")?.focus();
  }

  private showEmpty(): void {
    this.titleEl.textContent = "No note";
    this.dotEl.className = "dirty-dot";
    this.deleteBtn.hidden = true;
    this.body.replaceChildren(
      h(
        "div",
        { class: "pane-empty" },
        h("p", { class: "pane-empty-lead" }, "Pick a note from the list, or start a new one."),
        h("button", { class: "btn", onclick: () => this.deps.newNote() }, "New note"),
        h("p", { class: "pane-empty-hint" }, `Alt+N new note · ${modKey}+K search · ${modKey}+\\ split`),
      ),
    );
  }

  private refreshHeader(): void {
    if (this.titleFrame) return;
    this.titleFrame = requestAnimationFrame(() => {
      this.titleFrame = 0;
      const b = this.buffer;
      if (!b) return;
      this.deleteBtn.hidden = false;
      this.titleEl.textContent = extractTitle(b.doc.toString(), b.path);
      this.titleEl.title = b.path;
      const state = b.lastError ? "error" : b.saving ? "saving" : b.dirty ? "dirty" : "clean";
      this.dotEl.className = `dirty-dot ${state}`;
      this.dotEl.title = { error: `Not saved: ${b.lastError}`, saving: "Saving…", dirty: "Unsaved changes", clean: "Saved" }[state];
    });
  }

  private async onDelete(): Promise<void> {
    const path = this.notePath;
    if (!path) return;
    if (!this.deleteArmed) {
      this.deleteBtn.classList.add("armed");
      this.deleteBtn.textContent = "Delete?";
      this.deleteArmed = setTimeout(() => this.disarm(), 3000);
      return;
    }
    this.disarm();
    await this.deps.deleteNote(path);
  }

  private disarm(): void {
    if (this.deleteArmed) clearTimeout(this.deleteArmed);
    this.deleteArmed = null;
    this.deleteBtn.classList.remove("armed");
    this.deleteBtn.innerHTML = icons.trash;
  }

  private teardown(): void {
    this.editor?.destroy();
    this.editor = null;
    this.buffer = null;
  }

  destroy(): void {
    this.loadSeq++;
    this.teardown();
    this.el.remove();
  }
}

export class PaneGrid {
  readonly el: HTMLElement;
  private readonly panes = new Map<string, Pane>();
  private readonly deps: PaneDeps;

  constructor(deps: PaneDeps) {
    this.deps = deps;
    this.el = h("div", { class: "pane-grid" });
  }

  /** Reconcile DOM panes with workspace state. DOM order never changes; grid-area places them. */
  render(): void {
    const { state } = this.deps.workspace;
    this.el.dataset.layout = state.layout;
    const ids = new Set(state.panes.map((p) => p.id));
    for (const [id, pane] of this.panes) {
      if (!ids.has(id)) {
        pane.destroy();
        this.panes.delete(id);
      }
    }
    state.panes.forEach((ps, i) => {
      let pane = this.panes.get(ps.id);
      if (!pane) {
        pane = new Pane(ps.id, this.deps);
        this.panes.set(ps.id, pane);
        this.el.append(pane.el);
        void pane.show(ps);
      } else if (pane.notePath !== ps.notePath) {
        void pane.show(ps);
      }
      pane.el.style.gridArea = AREAS[i];
      pane.el.classList.toggle("active", ps.id === state.activePaneId);
    });
    this.el.classList.toggle("multi", state.panes.length > 1);
  }

  focusActive(): void {
    this.panes.get(this.deps.workspace.state.activePaneId)?.focus();
  }
}
