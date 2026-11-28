// IDE mode's sidebar: a file tree of the current mode's folder (with any
// outside folders below it), and a Changes view (uncommitted files, then
// recent commits) that opens line diffs.

import type { ChangeEntry, CommitEntry, NoteMeta, OutsideFolder } from "../../shared/types.ts";
import { MODE_FOLDER, pathInMode, type Mode } from "../../shared/modes.ts";
import { baseName } from "../../shared/files.ts";
import { api } from "../api.ts";
import { h, icons, relativeTime } from "./dom.ts";
import { makeNoteDraggable } from "./dnd.ts";

export interface ExplorerDeps {
  mode: () => Mode;
  open: (path: string, toSide: boolean) => void;
  showDiff: (req: DiffRequest) => void;
  /** Ask for a new file or folder name inside `base` (a full path ending in "/"). */
  newIn: (kind: "file" | "folder", base: string) => void;
  /** Ask for an outside folder's full path. */
  addOutside: () => void;
  /** Outside folders are offered only when this server is reachable from this computer alone. */
  local: () => boolean;
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
  /** Full path of this folder ("Work/sensor", "@ab12cd34/src"). */
  full: string;
  dirs: Map<string, TreeDir>;
  files: NoteMeta[];
}

/** A file or folder to place in a tree: its full path, and its path inside the tree's root. */
interface TreeItem {
  full: string;
  rel: string;
  file?: NoteMeta;
}

type OutsideData = { files: NoteMeta[]; folders: string[] } | { error: string };

const STATUS_LABEL: Record<ChangeEntry["status"], string> = { A: "Added", M: "Modified", D: "Deleted" };

export class Explorer {
  readonly el: HTMLElement;
  private readonly tabButtons: HTMLButtonElement[];
  private readonly filesEl: HTMLElement;
  private readonly changesEl: HTMLElement;
  private tab: Tab = "files";
  private files: NoteMeta[] = [];
  private folders: string[] = [];
  private outside: OutsideFolder[] = [];
  private readonly outsideData = new Map<string, OutsideData>();
  /** Open folders, by tree key: "m:<path in mode>" or "o:<id>" / "o:<id>:<path>". */
  private readonly expanded = new Set<string>();
  private activePath: string | null = null;
  private changesSeq = 0;
  private openCommit: string | null = null;
  /** What the tree last drew, so refreshes that change nothing don't rebuild it (which would drop hovers and clicks). */
  private treeDrawn = "";
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
      h(
        "div",
        { class: "explorer-bar" },
        h("div", { class: "segmented mode-switch explorer-tabs", role: "group", "aria-label": "Explorer view" }, ...this.tabButtons),
        h("button", {
          type: "button",
          class: "icon-btn explorer-newfolder",
          title: "New folder",
          "aria-label": "New folder",
          html: icons.folderPlus,
          onclick: () => this.deps.newIn("folder", `${MODE_FOLDER[this.deps.mode()]}/`),
        }),
      ),
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

  setFiles(files: NoteMeta[], folders: string[] = this.folders): void {
    this.files = files;
    this.folders = folders;
    this.renderTree();
  }

  /** Re-read the outside folders and the contents of the open ones. */
  async refreshOutside(): Promise<void> {
    if (!this.deps.local()) {
      this.outside = [];
      return this.renderTree();
    }
    try {
      this.outside = await api.outside();
    } catch {
      this.outside = [];
    }
    await Promise.all(this.outside.filter((o) => this.expanded.has(`o:${o.id}`)).map((o) => this.loadOutside(o.id)));
    this.renderTree();
  }

  private async loadOutside(id: string): Promise<void> {
    try {
      const [files, folders] = await Promise.all([api.outsideFiles(id), api.outsideFolders(id)]);
      this.outsideData.set(id, { files, folders });
    } catch (err) {
      this.outsideData.set(id, { error: (err as Error).message });
    }
  }

  setActivePath(path: string | null): void {
    this.activePath = path;
    if (path) {
      // Unfold the folders above the open file.
      const m = /^@([0-9a-f]{8})\/(.*)$/.exec(path);
      const parts = (m ? m[2] : pathInMode(path)).split("/");
      if (m) this.expanded.add(`o:${m[1]}`);
      for (let i = 1; i < parts.length; i++) this.expanded.add(m ? `o:${m[1]}:${parts.slice(0, i).join("/")}` : `m:${parts.slice(0, i).join("/")}`);
    }
    this.renderTree();
  }

  // --- files -------------------------------------------------------------------

  private renderTree(): void {
    const drawn = JSON.stringify([
      this.files.map((f) => [f.path, f.conflict]),
      this.folders,
      this.outside,
      [...this.outsideData],
      [...this.expanded].sort(),
      this.activePath,
      this.deps.local(),
      this.deps.mode(),
    ]);
    if (drawn === this.treeDrawn) return;
    this.treeDrawn = drawn;
    const rows: HTMLElement[] = [];
    const items: TreeItem[] = [
      ...this.folders.map((full) => ({ full, rel: pathInMode(`${full}/x`).slice(0, -2) })),
      ...this.files.map((f) => ({ full: f.path, rel: pathInMode(f.path), file: f })),
    ].filter((i) => i.rel);
    if (items.length) rows.push(...this.treeRows(items, "m", 0));
    else rows.push(h("p", { class: "list-empty" }, "No files yet. Press + to add one, e.g. scripts/hello.py"));

    if (this.deps.local()) {
      rows.push(
        h(
          "div",
          { class: "outside-head" },
          h("h3", { class: "changes-head" }, "Outside folders"),
          h("button", { type: "button", class: "btn btn-small outside-add", title: "Show a folder from this computer here (it isn't synced)", onclick: () => this.deps.addOutside() }, "Add folder…"),
        ),
      );
      if (!this.outside.length) rows.push(h("p", { class: "changes-empty" }, "Project folders elsewhere on this computer. Not synced through your notes."));
      for (const o of this.outside) rows.push(...this.outsideRows(o));
    }
    this.filesEl.replaceChildren(...rows);
  }

  private outsideRows(o: OutsideFolder): HTMLElement[] {
    const key = `o:${o.id}`;
    const open = this.expanded.has(key);
    const rows: HTMLElement[] = [
      this.dirLine(
        key,
        o.name,
        0,
        `@${o.id}/`,
        `${o.path} (on this computer, not synced)`,
        h("button", {
          type: "button",
          class: "icon-btn tree-act",
          title: "Remove from the list (the folder and its files stay on disk)",
          "aria-label": `Remove ${o.name} from the list`,
          html: icons.close,
          onclick: async (e: Event) => {
            e.stopPropagation();
            await api.removeOutside(o.id).catch(() => undefined);
            this.outsideData.delete(o.id);
            await this.refreshOutside();
          },
        }),
        true,
      ),
    ];
    if (!open) return rows;
    const data = this.outsideData.get(o.id);
    if (!data) rows.push(h("p", { class: "changes-empty tree-note" }, "Loading…"));
    else if ("error" in data) rows.push(h("p", { class: "changes-empty tree-note" }, data.error));
    else {
      const prefix = `@${o.id}/`;
      const items: TreeItem[] = [
        ...data.folders.map((full) => ({ full, rel: full.slice(prefix.length) })),
        ...data.files.map((f) => ({ full: f.path, rel: f.path.slice(prefix.length), file: f })),
      ];
      if (items.length) rows.push(...this.treeRows(items, key, 1));
      else rows.push(h("p", { class: "changes-empty tree-note" }, "No text or code files here."));
    }
    return rows;
  }

  /** Rows for one tree: folders first (open ones expanded), then files. */
  private treeRows(items: TreeItem[], keyBase: string, baseDepth: number): HTMLElement[] {
    const prefixOf = (i: TreeItem) => i.full.slice(0, i.full.length - i.rel.length);
    const root: TreeDir = { full: prefixOf(items[0]).replace(/\/$/, ""), dirs: new Map(), files: [] };
    for (const it of items) {
      const parts = it.rel.split("/");
      const dirParts = it.file ? parts.slice(0, -1) : parts;
      let dir = root;
      let relSoFar = "";
      for (const p of dirParts) {
        relSoFar = relSoFar ? `${relSoFar}/${p}` : p;
        let next = dir.dirs.get(p);
        if (!next) dir.dirs.set(p, (next = { full: prefixOf(it) + relSoFar, dirs: new Map(), files: [] }));
        dir = next;
      }
      if (it.file) dir.files.push(it.file);
    }
    const rows: HTMLElement[] = [];
    const walk = (dir: TreeDir, relPrefix: string, depth: number) => {
      for (const name of [...dir.dirs.keys()].sort((a, b) => a.localeCompare(b))) {
        const rel = relPrefix ? `${relPrefix}/${name}` : name;
        const key = `${keyBase}:${rel}`;
        const sub = dir.dirs.get(name)!;
        rows.push(this.dirLine(key, name, depth, `${sub.full}/`, sub.full, null, false));
        if (this.expanded.has(key)) walk(sub, rel, depth + 1);
      }
      for (const f of [...dir.files].sort((a, b) => baseName(a.path).localeCompare(baseName(b.path)))) {
        const row = h(
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
        );
        makeNoteDraggable(row, f.path);
        rows.push(row);
      }
    };
    walk(root, "", baseDepth);
    return rows;
  }

  /** A folder row: click to open/close; hover shows "new file here" (and any extra action). */
  private dirLine(key: string, name: string, depth: number, base: string, title: string, extra: HTMLElement | null, outsideRoot: boolean): HTMLElement {
    const open = this.expanded.has(key);
    return h(
      "div",
      { class: "tree-line" },
      h(
        "button",
        {
          type: "button",
          class: `tree-row tree-dir${outsideRoot ? " tree-outside" : ""}`,
          role: "treeitem",
          "aria-expanded": String(open),
          "data-key": key,
          title,
          style: `--depth:${depth}`,
          onclick: async () => {
            if (this.expanded.has(key)) this.expanded.delete(key);
            else {
              this.expanded.add(key);
              const id = /^o:([0-9a-f]{8})$/.exec(key)?.[1];
              if (id && !this.outsideData.has(id)) {
                this.renderTree();
                await this.loadOutside(id);
              }
            }
            this.renderTree();
          },
        },
        h("span", { class: `tree-chevron${open ? " open" : ""}`, "aria-hidden": "true" }, "›"),
        h("span", { class: "tree-icon", html: outsideRoot ? icons.folderLink : icons.folder }),
        h("span", { class: "tree-name" }, name),
      ),
      h(
        "span",
        { class: "tree-acts" },
        h("button", {
          type: "button",
          class: "icon-btn tree-act",
          title: `New file in ${name}`,
          "aria-label": `New file in ${name}`,
          html: icons.plus,
          onclick: (e: Event) => {
            e.stopPropagation();
            this.expanded.add(key);
            this.deps.newIn("file", base);
          },
        }),
        h("button", {
          type: "button",
          class: "icon-btn tree-act",
          title: `New folder in ${name}`,
          "aria-label": `New folder in ${name}`,
          html: icons.folderPlus,
          onclick: (e: Event) => {
            e.stopPropagation();
            this.expanded.add(key);
            this.deps.newIn("folder", base);
          },
        }),
        extra,
      ),
    );
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
