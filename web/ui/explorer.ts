// IDE mode's sidebar: a file tree of the current mode's folder, and a Changes
// view (uncommitted files, then recent commits) that opens line diffs.

import type { ChangeEntry, CommitEntry, NoteMeta } from "../../shared/types.ts";
import { pathInMode, type Mode } from "../../shared/modes.ts";
import { baseName } from "../../shared/files.ts";
import { api } from "../api.ts";
import { h, icons, relativeTime } from "./dom.ts";

export interface ExplorerDeps {
  mode: () => Mode;
  open: (path: string, toSide: boolean) => void;
  showDiff: (req: DiffRequest) => void;
}

/** One file's change. Each side is a commit ("HEAD" or a hash), "now" (the file as saved), or null (no file). */
export interface DiffRequest {
  path: string;
  status: ChangeEntry["status"];
  title: string;
  before: string | null;
  after: string | null;
}

type Tab = "files" | "changes";

interface TreeDir {
  dirs: Map<string, TreeDir>;
  files: NoteMeta[];
}

const STATUS_LABEL: Record<ChangeEntry["status"], string> = { A: "Added", M: "Modified", D: "Deleted" };

export class Explorer {
  readonly el: HTMLElement;
  private readonly tabButtons: HTMLButtonElement[];
  private readonly filesEl: HTMLElement;
  private readonly changesEl: HTMLElement;
  private tab: Tab = "files";
  private files: NoteMeta[] = [];
  private readonly expanded = new Set<string>();
  private activePath: string | null = null;
  private changesSeq = 0;
  private openCommit: string | null = null;
  private readonly deps: ExplorerDeps;

  constructor(deps: ExplorerDeps) {
    this.deps = deps;
    this.tabButtons = (["files", "changes"] as Tab[]).map((t) =>
      h("button", { type: "button", "data-tab": t, "aria-pressed": String(t === this.tab), onclick: () => this.setTab(t) }, t === "files" ? "Files" : "Changes"),
    );
    this.filesEl = h("div", { class: "tree", role: "tree", "aria-label": "Files" });
    this.changesEl = h("div", { class: "changes", hidden: true, "aria-label": "Changes" });
    this.el = h(
      "div",
      { class: "explorer" },
      h("div", { class: "segmented mode-switch explorer-tabs", role: "group", "aria-label": "Explorer view" }, ...this.tabButtons),
      this.filesEl,
      this.changesEl,
    );
  }

  get showingChanges(): boolean {
    return this.tab === "changes";
  }

  setTab(t: Tab): void {
    this.tab = t;
    for (const b of this.tabButtons) b.setAttribute("aria-pressed", String(b.dataset.tab === t));
    this.filesEl.hidden = t !== "files";
    this.changesEl.hidden = t !== "changes";
    if (t === "changes") void this.refreshChanges();
  }

  setFiles(files: NoteMeta[]): void {
    this.files = files;
    this.renderTree();
  }

  setActivePath(path: string | null): void {
    this.activePath = path;
    if (path) {
      // Unfold the folders above the open file.
      const parts = pathInMode(path).split("/");
      for (let i = 1; i < parts.length; i++) this.expanded.add(parts.slice(0, i).join("/"));
    }
    this.renderTree();
  }

  // --- files -------------------------------------------------------------------

  private renderTree(): void {
    if (!this.files.length) {
      this.filesEl.replaceChildren(h("p", { class: "list-empty" }, "No files yet. Press + to add one, e.g. scripts/hello.py"));
      return;
    }
    const root: TreeDir = { dirs: new Map(), files: [] };
    for (const f of this.files) {
      const parts = pathInMode(f.path).split("/");
      let dir = root;
      for (const p of parts.slice(0, -1)) {
        let next = dir.dirs.get(p);
        if (!next) dir.dirs.set(p, (next = { dirs: new Map(), files: [] }));
        dir = next;
      }
      dir.files.push(f);
    }
    const rows: HTMLElement[] = [];
    const walk = (dir: TreeDir, prefix: string, depth: number) => {
      for (const name of [...dir.dirs.keys()].sort((a, b) => a.localeCompare(b))) {
        const key = prefix ? `${prefix}/${name}` : name;
        const open = this.expanded.has(key);
        rows.push(
          h(
            "button",
            {
              type: "button",
              class: "tree-row tree-dir",
              role: "treeitem",
              "aria-expanded": String(open),
              style: `--depth:${depth}`,
              onclick: () => {
                if (this.expanded.has(key)) this.expanded.delete(key);
                else this.expanded.add(key);
                this.renderTree();
              },
            },
            h("span", { class: `tree-chevron${open ? " open" : ""}`, "aria-hidden": "true" }, "›"),
            h("span", { class: "tree-icon", html: icons.folder }),
            h("span", { class: "tree-name" }, name),
          ),
        );
        if (open) walk(dir.dirs.get(name)!, key, depth + 1);
      }
      for (const f of [...dir.files].sort((a, b) => baseName(a.path).localeCompare(baseName(b.path)))) {
        rows.push(
          h(
            "button",
            {
              type: "button",
              class: `tree-row tree-file${f.path === this.activePath ? " active" : ""}${f.conflict ? " is-conflict" : ""}`,
              role: "treeitem",
              "data-path": f.path,
              title: f.path,
              style: `--depth:${depth}`,
              onclick: (e: MouseEvent) => this.deps.open(f.path, e.metaKey || e.ctrlKey),
            },
            h("span", { class: "tree-chevron", "aria-hidden": "true" }),
            h("span", { class: "tree-name" }, baseName(f.path)),
          ),
        );
      }
    };
    walk(root, "", 0);
    this.filesEl.replaceChildren(...rows);
  }

  // --- changes -----------------------------------------------------------------

  async refreshChanges(): Promise<void> {
    const seq = ++this.changesSeq;
    const mode = this.deps.mode();
    let changes: ChangeEntry[];
    let commits: CommitEntry[];
    try {
      [changes, commits] = await Promise.all([api.gitChanges(mode), api.gitCommits(mode)]);
    } catch (err) {
      if (seq === this.changesSeq) this.changesEl.replaceChildren(h("p", { class: "list-empty" }, `Couldn't read git history: ${(err as Error).message}`));
      return;
    }
    if (seq !== this.changesSeq) return;
    const fileRow = (c: ChangeEntry, before: string | null, after: string | null, subtitle: string) =>
      h(
        "button",
        {
          type: "button",
          class: "change-row",
          "data-path": c.path,
          title: `${STATUS_LABEL[c.status]}: ${c.path}`,
          onclick: () => this.deps.showDiff({ path: c.path, status: c.status, title: subtitle, before, after }),
        },
        h("span", { class: `change-status st-${c.status}` }, c.status),
        h("span", { class: "change-path" }, pathInMode(c.path)),
      );
    const out: HTMLElement[] = [h("h3", { class: "changes-head" }, "Not synced yet")];
    if (changes.length) {
      // Compare with the last commit; deleted files have no "now".
      for (const c of changes) out.push(fileRow(c, c.status === "A" ? null : "HEAD", c.status === "D" ? null : "now", "Not synced yet"));
    } else {
      out.push(h("p", { class: "changes-empty" }, "Nothing waiting: every change is committed."));
    }
    out.push(h("h3", { class: "changes-head" }, "Recent commits"));
    if (!commits.length) out.push(h("p", { class: "changes-empty" }, "No commits yet. With sync on, each sync records one."));
    for (const c of commits) {
      const open = this.openCommit === c.commit;
      const label = c.machine ? `${c.machine}` : c.message;
      out.push(
        h(
          "button",
          {
            type: "button",
            class: "commit-row",
            "aria-expanded": String(open),
            title: c.message,
            onclick: () => {
              this.openCommit = open ? null : c.commit;
              void this.refreshChanges();
            },
          },
          h("span", { class: `tree-chevron${open ? " open" : ""}`, "aria-hidden": "true" }, "›"),
          h("span", { class: "commit-label" }, label),
          h("span", { class: "commit-meta" }, `${c.files.length} file${c.files.length === 1 ? "" : "s"} · ${relativeTime(c.timeMs)}`),
        ),
      );
      if (open) {
        const when = new Date(c.timeMs).toLocaleString();
        for (const f of c.files) {
          out.push(fileRow(f, f.status === "A" ? null : c.parent, f.status === "D" ? null : c.commit, `${c.machine ?? "Commit"} · ${when}`));
        }
      }
    }
    this.changesEl.replaceChildren(...out);
  }
}

/** The text on each side of a change (empty where there was no file). */
export async function loadDiffSides(req: DiffRequest): Promise<{ before: string; after: string }> {
  const at = async (side: string | null): Promise<string> => {
    if (side === null) return "";
    if (side === "now") return (await api.read(req.path).catch(() => ({ text: "" }))).text;
    return (await api.gitFile(side, req.path).catch(() => ({ text: "" }))).text;
  };
  const [before, after] = await Promise.all([at(req.before), at(req.after)]);
  return { before: before.replace(/\r\n/g, "\n"), after: after.replace(/\r\n/g, "\n") };
}
