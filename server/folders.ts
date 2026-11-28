// Outside folders for IDE mode: project folders elsewhere on this computer
// (e.g. C:\code\sensor) shown in the file tree and edited like notes. They
// are NOT part of the notes repo: nothing here commits, syncs or moves files.
//
// Only offered when the server listens on this computer alone (no network,
// no Tailscale name): a phone or another machine must never browse the disk.
// The server enforces that; see AppContext.outside in http.ts.
//
// Files are addressed as "@<id>/<path inside the folder>", where <id> is a
// short hash of the folder's absolute path, stable across restarts.

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerEvent } from "../shared/types.ts";
import { Queue } from "./git.ts";
import { NoteStore } from "./notes.ts";
import { NoteWatcher } from "./watcher.ts";

export type { OutsideFolder } from "../shared/types.ts";
import type { OutsideFolder } from "../shared/types.ts";

interface Entry extends OutsideFolder {
  store: NoteStore;
  watcher: NoteWatcher;
}

export class FolderError extends Error {}

export function folderId(abs: string): string {
  const key = process.platform === "win32" ? path.resolve(abs).toLowerCase() : path.resolve(abs);
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

/** "@ab12cd34/src/main.py" → { id, rel }; null for an ordinary notes path. */
export function parseOutsidePath(p: string): { id: string; rel: string } | null {
  const m = /^@([0-9a-f]{8})\/(.+)$/.exec(p);
  return m ? { id: m[1], rel: m[2] } : null;
}

const inside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

export class OutsideFolders {
  private readonly entries = new Map<string, Entry>();
  private readonly opts: { machineName: string; notesRoot: () => string | null; onEvent: (ev: ServerEvent) => void; onChange: (paths: string[]) => void };

  constructor(opts: OutsideFolders["opts"]) {
    this.opts = opts;
  }

  /** Re-open the saved folders at startup; ones that have gone missing are skipped (and kept in the list). */
  open(paths: string[]): void {
    for (const p of paths) {
      try {
        this.start(this.check(p, false));
      } catch {
        /* folder unplugged or deleted: leave it out until it's back */
      }
    }
  }

  list(): OutsideFolder[] {
    return [...this.entries.values()].map(({ id, name, path: p }) => ({ id, name, path: p }));
  }

  store(id: string): NoteStore {
    const e = this.entries.get(id);
    if (!e) throw new FolderError("That outside folder isn't open in Notes any more.");
    return e.store;
  }

  /** Add a folder by absolute path. Refuses roots, the home folder itself, and anything overlapping the notes folder. */
  add(p: string): OutsideFolder {
    const abs = this.check(p, true);
    const e = this.start(abs);
    this.opts.onChange(this.list().map((f) => f.path));
    return { id: e.id, name: e.name, path: e.path };
  }

  /** Forget a folder (its files stay where they are). */
  remove(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.watcher.stop();
    this.entries.delete(id);
    this.opts.onChange(this.list().map((f) => f.path));
  }

  stopAll(): void {
    for (const e of this.entries.values()) e.watcher.stop();
    this.entries.clear();
  }

  private check(p: string, adding: boolean): string {
    if (typeof p !== "string" || !p.trim()) throw new FolderError("Type the folder's full path, e.g. C:\\code\\my-project");
    const raw = p.trim().replace(/^"(.*)"$/, "$1");
    if (!path.isAbsolute(raw)) throw new FolderError("Use the folder's full path, e.g. C:\\code\\my-project or /home/me/code/project");
    const abs = path.resolve(raw);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      throw new FolderError(`There's no folder at ${abs}`);
    }
    if (!st.isDirectory()) throw new FolderError(`${abs} is a file, not a folder`);
    if (path.parse(abs).root === abs) throw new FolderError("A whole drive is too much to open; choose a project folder inside it.");
    if (path.resolve(os.homedir()) === abs) throw new FolderError("Your whole home folder is too much to open; choose a project folder inside it.");
    const notes = this.opts.notesRoot();
    if (notes && (inside(abs, notes) || inside(notes, abs))) throw new FolderError("That folder is (or contains) your notes folder, which is already in the tree.");
    if (adding && this.entries.has(folderId(abs))) throw new FolderError("That folder is already open.");
    return abs;
  }

  private start(abs: string): Entry {
    const id = folderId(abs);
    const store = new NoteStore({ root: abs, worktreeLock: new Queue(), machineName: this.opts.machineName, followMoves: false });
    const watcher = new NoteWatcher(store);
    const at = (p: string) => `@${id}/${p}`;
    watcher.on("changed", (paths) => {
      for (const p of paths) {
        const k = store.known.get(p);
        if (k) this.opts.onEvent({ type: "note-changed", path: at(p), hash: k.hash });
      }
      this.opts.onEvent({ type: "notes-changed" });
    });
    watcher.on("deleted", (paths) => {
      for (const p of paths) this.opts.onEvent({ type: "note-deleted", path: at(p) });
      this.opts.onEvent({ type: "notes-changed" });
    });
    const e: Entry = { id, name: path.basename(abs), path: abs, store, watcher };
    this.entries.set(id, e);
    void store.scan().then(() => watcher.start());
    return e;
  }
}
