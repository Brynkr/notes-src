// Everything that depends on a configured notes repo: git, note store,
// search index, watcher, sync. The HTTP server outlives it, so settings
// changes (another folder, another remote) can stop one runtime and start a
// new one without restarting the process.

import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { HistoryEntry, ServerEvent, SyncStatusDto } from "../shared/types.ts";
import { dataDir, type Config } from "./config.ts";
import { Git, Queue } from "./git.ts";
import { NoteStore } from "./notes.ts";
import { modeFolderOf } from "../shared/modes.ts";
import { SearchIndex } from "./search.ts";
import { isEarlierVersion, SyncEngine, SyncScheduler } from "./sync.ts";
import { NoteWatcher } from "./watcher.ts";

export const DEFAULT_GITIGNORE = `# Written by notes-app. Edit freely.
.DS_Store
Thumbs.db
desktop.ini
*.tmp
*.swp
`;

/** Same line endings on every machine (Windows git otherwise converts them). */
export const DEFAULT_GITATTRIBUTES = `# Written by notes-app: keep line endings identical on every machine.
*.md text eol=lf
*.markdown text eol=lf
*.txt text eol=lf
`;

/** Add .gitignore/.gitattributes to a repo we just created or cloned, if missing. */
export function writeRepoDefaults(dir: string): void {
  for (const [name, text] of [
    [".gitignore", DEFAULT_GITIGNORE],
    [".gitattributes", DEFAULT_GITATTRIBUTES],
  ]) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) fs.writeFileSync(p, text);
  }
}

export interface RuntimeEvents {
  event: [ServerEvent];
}

export class NotesRuntime extends EventEmitter<RuntimeEvents> {
  readonly cfg: Config;
  readonly repoRoot: string;
  readonly notesRoot: string;
  readonly git: Git;
  readonly store: NoteStore;
  readonly search: SearchIndex;
  readonly engine: SyncEngine;
  readonly scheduler: SyncScheduler;
  readonly watcher: NoteWatcher;

  private constructor(cfg: Config, repoRoot: string) {
    super();
    this.cfg = cfg;
    this.repoRoot = repoRoot;
    this.notesRoot = path.resolve(cfg.repoPath, cfg.notesDir);
    this.git = new Git(repoRoot);
    const worktreeLock = new Queue();
    this.store = new NoteStore({ root: this.notesRoot, worktreeLock, machineName: cfg.machineName });
    const indexFile = path.join(dataDir(), "index", createHash("sha256").update(this.notesRoot).digest("hex").slice(0, 16) + ".sqlite");
    this.search = new SearchIndex(indexFile);
    this.engine = new SyncEngine({ git: this.git, remote: cfg.remote, branch: cfg.branch, machineName: cfg.machineName, worktreeLock });
    this.scheduler = new SyncScheduler(this.engine, { idleMs: cfg.syncIdleSeconds * 1000, intervalMs: cfg.syncIntervalSeconds * 1000 });
    this.watcher = new NoteWatcher(this.store);
  }

  /** Validate the folder, open the index, start watching and syncing. */
  static async start(cfg: Config): Promise<NotesRuntime> {
    const repoRoot = await ensureRepo(cfg);
    const rt = new NotesRuntime(cfg, repoRoot);
    fs.mkdirSync(rt.notesRoot, { recursive: true });
    const moved = await rt.moveIntoModes();
    await rt.store.scan();
    const indexed = rt.search.indexed();
    for (const [p, k] of rt.store.known) if (indexed.get(p) !== k.hash) rt.reindex(p);
    for (const p of indexed.keys()) if (!rt.store.known.has(p)) rt.search.remove(p);
    rt.wire();
    rt.watcher.start();
    if (cfg.sync) {
      rt.scheduler.start();
      if (moved.length) rt.scheduler.noteSaved(); // commit the moves soon
    }
    return rt;
  }

  /**
   * Move notes outside Home/ and Work/ into Home/. The first time (when there
   * are any), pull first so edits other machines made at the old paths are
   * moved too rather than arriving later beside a stale copy. That pull waits
   * at most 15 s, so an offline start isn't held up for long.
   */
  private async moveIntoModes(): Promise<[string, string][]> {
    const outside = (await this.store.walk()).some((p) => !modeFolderOf(p));
    if (!outside) return [];
    if (this.cfg.sync) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        this.engine.request().catch(() => undefined),
        new Promise((r) => (timer = setTimeout(r, 15_000))),
      ]);
      clearTimeout(timer);
    }
    const prefix = path.relative(this.repoRoot, this.notesRoot).split(path.sep).join("/");
    return this.store.moveIntoModes((rel, homeAbs) => isEarlierVersion(this.git, prefix ? `${prefix}/${rel}` : rel, homeAbs));
  }

  private emitEvent(ev: ServerEvent): void {
    this.emit("event", ev);
  }

  private wire(): void {
    const notesPrefix = path.relative(this.repoRoot, this.notesRoot).split(path.sep).join("/");
    this.watcher.on("changed", (paths) => {
      for (const p of paths) {
        this.reindex(p);
        const k = this.store.known.get(p);
        if (k) this.emitEvent({ type: "note-changed", path: p, hash: k.hash });
      }
      this.emitEvent({ type: "notes-changed" });
      this.emitEvent({ type: "status", status: this.status() });
    });
    this.watcher.on("deleted", (paths) => {
      for (const p of paths) {
        this.search.remove(p);
        this.emitEvent({ type: "note-deleted", path: p });
      }
      this.emitEvent({ type: "notes-changed" });
      this.emitEvent({ type: "status", status: this.status() });
    });
    this.engine.on("status", () => this.emitEvent({ type: "status", status: this.status() }));
    this.engine.on("merged", (repoPaths: string[]) => {
      const prefix = notesPrefix ? notesPrefix + "/" : "";
      this.watcher.poke(repoPaths.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length)));
    });
  }

  reindex(p: string): void {
    const k = this.store.known.get(p);
    if (!k) return this.search.remove(p);
    try {
      this.search.upsert(p, k.hash, fs.readFileSync(this.store.resolve(p), "utf8"));
    } catch {
      /* deleted in the meantime: the watcher will report it */
    }
  }

  /** After a write through the API. */
  saved(paths: string[]): void {
    for (const p of paths) this.reindex(p);
    if (this.cfg.sync) this.scheduler.noteSaved();
    this.emitEvent({ type: "status", status: this.status() });
  }

  status(): SyncStatusDto {
    const s = this.engine.status;
    const conflicts = [...this.store.known.values()].filter((k) => k.meta.conflict).map((k) => k.meta.path).sort();
    let state: SyncStatusDto["state"] = this.cfg.sync ? s.state : "disabled";
    if (state === "synced" && conflicts.length) state = "conflict";
    if (state === "conflict" && !conflicts.length) state = "synced";
    return {
      state,
      lastSyncMs: s.lastSyncMs,
      lastAttemptMs: s.lastAttemptMs,
      message: this.cfg.sync ? s.message : "Sync is turned off.",
      conflicts,
      ahead: s.ahead,
      skipped: s.skipped,
    };
  }

  private repoRel(notePath: string): string {
    this.store.resolve(notePath); // validates
    const prefix = path.relative(this.repoRoot, this.notesRoot).split(path.sep).join("/");
    return prefix ? `${prefix}/${notePath}` : notePath;
  }

  /** Versions of a note recorded by sync commits, newest first (follows moves to/from the Trash). */
  async history(notePath: string, limit = 100): Promise<HistoryEntry[]> {
    const file = this.repoRel(notePath);
    const r = await this.git.run(
      ["log", "--follow", `-n${limit}`, "-z", "--name-only", "--format=%x1e%H%x1f%at%x1f%s", "--", file],
      { allowFail: true },
    );
    if (r.code !== 0) return []; // no commits yet
    const out: HistoryEntry[] = [];
    for (const rec of r.stdout.split("\x1e").filter((x) => x.trim())) {
      // "-z" ends the header with NUL (or newline, depending on git version); then the file name.
      const parts = rec.split(/[\0\n]/).map((x) => x.trim()).filter(Boolean);
      const [commit, at, message] = (parts[0] ?? "").split("\x1f");
      const name = parts[1] ?? file;
      const m = /^auto: \S+ (.+?)(?: \(kept .*\))?$/.exec(message);
      out.push({ commit, timeMs: Number(at) * 1000, machine: m ? m[1] : null, message, file: name });
    }
    return out;
  }

  /** A note's text at a given commit. */
  async version(commit: string, file: string): Promise<string> {
    if (!/^[0-9a-f]{7,64}$/.test(commit)) throw new Error("Bad commit id");
    if (!/\.(md|markdown)$/i.test(file) || file.split("/").some((s) => s === ".." || s === "") || file.includes("\0")) throw new Error("Bad path");
    const r = await this.git.run(["cat-file", "blob", `${commit}:${file}`], { binary: true, allowFail: true });
    if (r.code !== 0) throw new Error("That version isn't available.");
    return Buffer.from(r.stdout, "latin1").toString("utf8");
  }

  async syncNow(): Promise<SyncStatusDto> {
    if (this.cfg.sync) await this.scheduler.now();
    return this.status();
  }

  focus(): void {
    if (this.cfg.sync) this.scheduler.focus();
  }

  /** Stop watching and syncing; one last bounded sync first if enabled. */
  async stop(finalSyncMs = 10_000): Promise<void> {
    this.watcher.stop();
    if (this.cfg.sync) await this.scheduler.shutdown(finalSyncMs);
    this.search.close();
    this.removeAllListeners();
  }
}

/** Make sure repoPath is inside a git work tree; create one if the folder is new. Returns the repo root. */
export async function ensureRepo(cfg: Config): Promise<string> {
  fs.mkdirSync(cfg.repoPath, { recursive: true });
  const probe = new Git(cfg.repoPath);
  const top = await probe.run(["rev-parse", "--show-toplevel"], { allowFail: true });
  if (top.code === 0) return path.resolve(top.stdout.trim());
  await probe.run(["init", "-q", "-b", cfg.branch]);
  writeRepoDefaults(cfg.repoPath);
  return path.resolve(cfg.repoPath);
}
