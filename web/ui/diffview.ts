// A file's changes in one commit (or since the last commit), as a line diff.

import { pathInMode } from "../../shared/modes.ts";
import { h, icons } from "./dom.ts";
import { loadDiffSides, type DiffRequest } from "./explorer.ts";
import { renderDiff } from "./history.ts";

export class DiffDialog {
  readonly el: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly subEl: HTMLElement;
  private readonly body: HTMLElement;
  private readonly openBtn: HTMLButtonElement;
  private req: DiffRequest | null = null;
  private seq = 0;
  private readonly onClosed: () => void;

  constructor(opts: { open: (path: string) => void; onClosed: () => void }) {
    this.onClosed = opts.onClosed;
    this.titleEl = h("h2", {}, "Changes");
    this.subEl = h("span", { class: "muted diff-sub" });
    this.body = h("div", { class: "diff-body" });
    this.openBtn = h(
      "button",
      {
        type: "button",
        class: "btn",
        onclick: () => {
          const path = this.req?.path;
          this.close();
          if (path) opts.open(path);
        },
      },
      "Open file",
    );
    const panel = h(
      "div",
      {
        class: "dialog dialog-wide",
        role: "dialog",
        "aria-label": "File changes",
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === "Escape") this.close();
        },
      },
      h(
        "header",
        { class: "dialog-head" },
        h("div", { class: "diff-titles" }, this.titleEl, this.subEl),
        h("button", { type: "button", class: "icon-btn", "aria-label": "Close", html: icons.close, onclick: () => this.close() }),
      ),
      this.body,
      h(
        "footer",
        { class: "dialog-foot" },
        h("span", { class: "dialog-status history-legend" }, h("span", { class: "diff-add" }, "+ added"), " ", h("span", { class: "diff-del" }, "− removed")),
        h("span", { class: "spacer" }),
        this.openBtn,
        h("button", { type: "button", class: "btn btn-primary", onclick: () => this.close() }, "Close"),
      ),
    );
    this.el = h("div", { class: "dialog-backdrop", hidden: true, onmousedown: (e: MouseEvent) => e.target === this.el && this.close() }, panel);
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  async show(req: DiffRequest): Promise<void> {
    const seq = ++this.seq;
    this.req = req;
    this.el.hidden = false;
    this.titleEl.textContent = pathInMode(req.path);
    this.subEl.textContent = `${{ A: "Added", M: "Changed", D: "Deleted" }[req.status]} · ${req.title}`;
    this.openBtn.hidden = req.status === "D";
    this.body.replaceChildren(h("p", { class: "muted" }, "Loading…"));
    (this.el.querySelector(".dialog-head .icon-btn") as HTMLElement | null)?.focus();
    const { before, after } = await loadDiffSides(req);
    if (seq !== this.seq) return;
    this.body.replaceChildren(before === after ? h("p", { class: "muted" }, "No text changes.") : renderDiff(before, after));
  }

  close(): void {
    if (this.el.hidden) return;
    this.el.hidden = true;
    this.onClosed();
  }
}
