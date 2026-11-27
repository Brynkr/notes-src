// Trash dialog: notes moved to the Trash, with preview, restore and delete forever.

import type { TrashItem } from "../../shared/types.ts";
import { inMode, MODE_LABEL, pathInMode, type Mode } from "../../shared/modes.ts";
import { api } from "../api.ts";
import { h, icons, relativeTime, toast } from "./dom.ts";

export class TrashDialog {
  readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private readonly emptyBtn: HTMLButtonElement;
  private items: TrashItem[] = [];
  private openPreview: string | null = null;
  private readonly onRestored: (path: string) => void;
  private readonly onClosed: () => void;
  private readonly mode: () => Mode;
  private readonly heading: HTMLElement;

  constructor(opts: { onRestored: (path: string) => void; onClosed: () => void; mode: () => Mode }) {
    this.onRestored = opts.onRestored;
    this.onClosed = opts.onClosed;
    this.mode = opts.mode;
    this.heading = h("h2", {}, "Trash");
    this.list = h("div", { class: "trash-list" });
    this.emptyBtn = armed(h("button", { type: "button", class: "btn" }, "Empty Trash"), "Delete all forever?", () => this.emptyAll());
    const panel = h(
      "div",
      {
        class: "dialog",
        role: "dialog",
        "aria-label": "Trash",
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === "Escape") this.close();
        },
      },
      h("header", { class: "dialog-head" }, this.heading, h("button", { type: "button", class: "icon-btn", "aria-label": "Close", html: icons.close, onclick: () => this.close() })),
      h("div", { class: "dialog-body" }, h("p", { class: "muted trash-intro" }, "Deleted notes wait here, on every device, until you restore them or delete them forever. Even then, they stay in the repository's git history."), this.list),
      h("footer", { class: "dialog-foot" }, this.emptyBtn, h("span", { class: "spacer" }), h("button", { type: "button", class: "btn", onclick: () => this.close() }, "Close")),
    );
    this.el = h("div", { class: "dialog-backdrop", hidden: true, onmousedown: (e: MouseEvent) => e.target === this.el && this.close() }, panel);
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  async show(): Promise<void> {
    this.el.hidden = false;
    this.openPreview = null;
    this.emptyBtn.hidden = true;
    this.heading.textContent = `Trash · ${MODE_LABEL[this.mode()]}`;
    this.list.replaceChildren(h("p", { class: "muted" }, "Loading…"));
    await this.reload();
    this.el.querySelector<HTMLElement>(".dialog-head .icon-btn")?.focus();
  }

  close(): void {
    if (this.el.hidden) return;
    this.el.hidden = true;
    this.onClosed();
  }

  private async reload(): Promise<void> {
    try {
      const mode = this.mode();
      this.items = (await api.trash()).filter((t) => inMode(t.path, mode));
    } catch (err) {
      this.list.replaceChildren(h("p", { class: "bad" }, `Couldn't load the Trash: ${(err as Error).message}`));
      return;
    }
    this.render();
  }

  private render(): void {
    this.emptyBtn.hidden = this.items.length === 0;
    if (!this.items.length) {
      this.list.replaceChildren(h("p", { class: "list-empty" }, "The Trash is empty."));
      return;
    }
    this.list.replaceChildren(
      ...this.items.map((item) => {
        const preview = h("pre", { class: "trash-preview", hidden: this.openPreview !== item.path });
        if (this.openPreview === item.path) void this.loadPreview(item.path, preview);
        return h(
          "div",
          { class: "trash-row", "data-path": item.path },
          h(
            "button",
            {
              type: "button",
              class: "trash-title",
              title: "Show what's in it",
              "aria-expanded": String(this.openPreview === item.path),
              onclick: () => {
                this.openPreview = this.openPreview === item.path ? null : item.path;
                this.render();
              },
            },
            h("span", { class: "note-title" }, item.title),
            h("span", { class: "note-sub" }, `Deleted ${relativeTime(item.deletedMs)} · ${pathInMode(item.path)}`),
          ),
          h(
            "div",
            { class: "trash-actions" },
            h("button", { type: "button", class: "btn btn-small", onclick: () => this.restore(item) }, "Restore"),
            armed(h("button", { type: "button", class: "btn btn-small" }, "Delete forever"), "Sure?", () => this.purge(item)),
          ),
          preview,
        );
      }),
    );
  }

  private async loadPreview(path: string, el: HTMLElement): Promise<void> {
    el.textContent = "Loading…";
    try {
      el.textContent = (await api.readTrash(path)).text;
    } catch (err) {
      el.textContent = (err as Error).message;
    }
  }

  private async restore(item: TrashItem): Promise<void> {
    try {
      const { path } = await api.restoreTrash(item.path);
      toast(path === item.path ? `Restored “${item.title}”.` : `Restored “${item.title}” as ${path} (the old name was taken).`, "info");
      this.close();
      this.onRestored(path);
    } catch (err) {
      toast(`Couldn't restore: ${(err as Error).message}`, "error");
    }
  }

  private async purge(item: TrashItem): Promise<void> {
    try {
      await api.purgeTrash(item.path);
      await this.reload();
    } catch (err) {
      toast(`Couldn't delete: ${(err as Error).message}`, "error");
    }
  }

  /** Empties this mode's Trash only; the other mode's deleted notes stay. */
  private async emptyAll(): Promise<void> {
    try {
      let count = 0;
      for (const item of this.items) {
        await api.purgeTrash(item.path);
        count++;
      }
      toast(`Deleted ${count} note${count === 1 ? "" : "s"} forever.`, "info");
      await this.reload();
    } catch (err) {
      toast(`Couldn't empty the Trash: ${(err as Error).message}`, "error");
    }
  }
}

/** A button that needs a second click within 3 s (for irreversible actions). */
function armed(btn: HTMLButtonElement, confirmText: string, run: () => void): HTMLButtonElement {
  const label = btn.textContent ?? "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const disarm = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    btn.textContent = label;
    btn.classList.remove("danger");
  };
  btn.addEventListener("click", () => {
    if (!timer) {
      btn.textContent = confirmText;
      btn.classList.add("danger");
      timer = setTimeout(disarm, 3000);
      return;
    }
    disarm();
    run();
  });
  return btn;
}
