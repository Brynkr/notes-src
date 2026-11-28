// Debounced file watching. Turns raw fs events into "note changed/deleted"
// events, ignoring changes the app made itself (NoteStore.known holds the
// last hash we wrote or read). A slow periodic rescan backs up fs.watch,
// which can miss events on some filesystems.

import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { NoteStore } from "./notes.ts";
import { isTextFile, SKIP_DIRS } from "../shared/files.ts";

export interface WatcherEvents {
  changed: [paths: string[]];
  deleted: [paths: string[]];
}

export class NoteWatcher extends EventEmitter<WatcherEvents> {
  private fsWatcher: fs.FSWatcher | null = null;
  private pending = new Set<string>();
  private fullRescan = false;
  private timer: NodeJS.Timeout | null = null;
  private interval: NodeJS.Timeout | null = null;
  private running: Promise<void> = Promise.resolve();
  private readonly store: NoteStore;
  private readonly debounceMs: number;
  private readonly rescanMs: number;

  constructor(store: NoteStore, opts: { debounceMs?: number; rescanMs?: number } = {}) {
    super();
    this.store = store;
    this.debounceMs = opts.debounceMs ?? 150;
    this.rescanMs = opts.rescanMs ?? 60_000;
    // The store reports differences found by any scan, including ours.
    store.on("changed", (p) => this.emit("changed", p));
    store.on("deleted", (p) => this.emit("deleted", p));
  }

  start(): void {
    try {
      this.fsWatcher = fs.watch(this.store.root, { recursive: true }, (_event, filename) => {
        if (!filename) {
          this.fullRescan = true;
        } else {
          const rel = filename.toString().split(path.sep).join("/");
          if (rel.split("/").some((s) => s.startsWith(".") || SKIP_DIRS.has(s))) return; // .git, temp files, node_modules
          if (isTextFile(rel)) this.pending.add(rel);
          else this.fullRescan = true; // a folder was added, removed or renamed
        }
        this.schedule();
      });
      this.fsWatcher.on("error", () => {
        this.store.watched = false; // fall back to rescanning on list()
        this.fullRescan = true;
        this.schedule();
      });
      // Live watching works: listing can trust what the store already knows.
      this.store.watched = true;
    } catch {
      // Recursive watching unsupported here: rely on the periodic rescan.
    }
    if (this.rescanMs > 0) {
      this.interval = setInterval(() => this.poke(), this.rescanMs);
      this.interval.unref();
    }
  }

  /** Force a check, e.g. after a merge changed files. */
  poke(paths?: string[]): void {
    if (paths) for (const p of paths) this.pending.add(p);
    else this.fullRescan = true;
    this.schedule();
  }

  /** Resolves once all queued checks have run (used by tests). */
  async idle(): Promise<void> {
    while (this.timer || this.pending.size || this.fullRescan) {
      await new Promise((r) => setTimeout(r, this.debounceMs + 20));
    }
    await this.running;
  }

  stop(): void {
    this.store.watched = false;
    this.fsWatcher?.close();
    if (this.timer) clearTimeout(this.timer);
    if (this.interval) clearInterval(this.interval);
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.running = this.running.then(() => this.flush());
    }, this.debounceMs);
  }

  private async flush(): Promise<void> {
    const full = this.fullRescan;
    const paths = [...this.pending];
    this.fullRescan = false;
    this.pending.clear();
    try {
      await this.store.scan(full ? undefined : paths);
    } catch {
      // Transient (file mid-rename etc.). The next event or rescan will catch up.
    }
  }
}
