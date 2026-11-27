// Sync engine: commit local changes, fetch, merge (never rebase), resolve
// conflicts by keeping both versions, push. See HANDOVER.md section 10.
//
// Locking: `worktreeLock` is shared with the note writer (notes.ts). It is held
// only while git changes the working tree (commit, merge, conflict resolution),
// never during fetch or push, so saving a note never waits on the network.
// Lock order is always worktreeLock -> git queue.

import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { Git, GitError, Queue, splitZ, type GitResult, type RunOptions } from "./git.ts";

export type SyncState = "synced" | "syncing" | "offline" | "conflict" | "error" | "local";

export interface SyncStatus {
  state: SyncState;
  /** Time of the last fully successful sync (ms since epoch). */
  lastSyncMs: number | null;
  lastAttemptMs: number | null;
  /** Human-readable detail for offline/error states. */
  message: string | null;
  /** Repo-relative paths of conflict copies currently in the tree. */
  conflicts: string[];
  /** Local commits not yet on the remote. */
  ahead: number;
  /** Files left out of commits because they're over MAX_SYNC_BYTES. */
  skipped: { path: string; size: number }[];
}

/** Files bigger than this are never committed: they'd bloat the repo forever. */
export const MAX_SYNC_BYTES = 5 * 1024 * 1024;

export interface SyncHooks {
  /** Called before each push attempt. Tests use it to move the remote. */
  beforePush?: (attempt: number) => Promise<void> | void;
  /** Called for each conflicted path during resolution. Tests use it to inject failures. */
  duringResolve?: (path: string) => Promise<void> | void;
}

export interface SyncOptions {
  git: Git;
  remote: string;
  branch: string;
  machineName: string;
  worktreeLock: Queue;
  networkTimeoutMs?: number;
  maxPushAttempts?: number;
  hooks?: SyncHooks;
  /** Clock, injectable for tests. */
  now?: () => Date;
}

type G = (args: string[], options?: RunOptions) => Promise<GitResult>;

export { isConflictCopy } from "../shared/conflicts.ts";
import { isConflictCopy } from "../shared/conflicts.ts";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function sanitizeHost(h: string): string {
  return h.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40) || "remote";
}

export class SyncEngine extends EventEmitter {
  readonly opts: Required<Omit<SyncOptions, "hooks">> & { hooks: SyncHooks };
  status: SyncStatus = { state: "syncing", lastSyncMs: null, lastAttemptMs: null, message: null, conflicts: [], ahead: 0, skipped: [] };

  private chain: Promise<unknown> = Promise.resolve();
  private queued: Promise<SyncStatus> | null = null;

  constructor(opts: SyncOptions) {
    super();
    this.opts = {
      networkTimeoutMs: 60_000,
      maxPushAttempts: 3,
      now: () => new Date(),
      hooks: {},
      ...opts,
    } as SyncEngine["opts"];
  }

  /**
   * Ask for a sync. Requests made while a sync is running cause exactly one
   * more run after it; requests made while one is already waiting join it.
   */
  request(): Promise<SyncStatus> {
    if (this.queued) return this.queued;
    const p = this.chain.then(() => {
      this.queued = null;
      return this.syncOnce();
    });
    this.queued = p;
    this.chain = p.catch(() => undefined);
    return p;
  }

  private setStatus(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit("status", this.status);
  }

  /** One full sync. Never throws: failures are reported through status. */
  private async syncOnce(): Promise<SyncStatus> {
    const { git, remote } = this.opts;
    const started = Date.now();
    this.setStatus({ state: "syncing", lastAttemptMs: started });
    try {
      await this.preflight();
      const hasRemote = (await git.run(["remote", "get-url", remote], { allowFail: true })).code === 0;

      await this.commitPhase();
      if (!hasRemote) {
        const conflicts = await this.listConflicts();
        this.setStatus({
          state: "local",
          message: `No remote named "${remote}". Notes are committed locally but not synced.`,
          conflicts,
          ahead: 0,
        });
        return this.status;
      }

      await this.fetch();
      await this.mergePhase();
      await this.pushPhase();

      const conflicts = await this.listConflicts();
      this.setStatus({
        state: conflicts.length ? "conflict" : "synced",
        lastSyncMs: Date.now(),
        message: null,
        conflicts,
        ahead: 0,
      });
    } catch (err) {
      const conflicts = await this.listConflicts().catch(() => this.status.conflicts);
      const ahead = await this.countAhead().catch(() => this.status.ahead);
      if (err instanceof GitError && err.kind === "network") {
        this.setStatus({ state: "offline", message: err.message, conflicts, ahead });
      } else if (err instanceof GitError && err.kind === "auth") {
        this.setStatus({ state: "error", message: `Authentication failed. git said: ${err.message}`, conflicts, ahead });
      } else if (err instanceof GitError && err.kind === "missing-git") {
        this.setStatus({ state: "error", message: err.message, conflicts, ahead });
      } else {
        this.setStatus({ state: "error", message: (err as Error).message, conflicts, ahead });
      }
    }
    return this.status;
  }

  /** Refuse to touch a repo that a human is in the middle of working on. */
  private async preflight(): Promise<void> {
    const { git, branch } = this.opts;
    const gitDir = (await git.run(["rev-parse", "--absolute-git-dir"])).stdout.trim();
    for (const marker of ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD"]) {
      if (await exists(path.join(gitDir, marker))) {
        throw new Error(`The notes repo has an unfinished ${marker === "MERGE_HEAD" ? "merge" : "rebase or cherry-pick"}. Finish or abort it with git, then sync again.`);
      }
    }
    const head = (await git.run(["symbolic-ref", "-q", "--short", "HEAD"], { allowFail: true })).stdout.trim();
    if (head !== branch) {
      throw new Error(head ? `The notes repo is on branch "${head}" but sync is set to "${branch}".` : "The notes repo has a detached HEAD.");
    }
  }

  private async commitPhase(): Promise<void> {
    await this.opts.worktreeLock.run(() => this.opts.git.exclusive((g) => this.commitLocal(g)));
  }

  private async commitLocal(g: G): Promise<boolean> {
    const st = await g(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (!st.stdout) {
      if (this.status.skipped.length) this.setStatus({ skipped: [] });
      return false;
    }
    await g(["add", "-A"]);
    await this.unstageBigFiles(g);
    const staged = await g(["diff", "--cached", "--quiet"], { allowFail: true });
    if (staged.code === 0) return false;
    const stamp = this.opts.now().toISOString();
    await g(["commit", "-q", "-m", `auto: ${stamp} ${this.opts.machineName}`]);
    return true;
  }

  /** Leave files over MAX_SYNC_BYTES out of the commit (unstaged, untouched on disk). */
  private async unstageBigFiles(g: G): Promise<void> {
    const staged = splitZ((await g(["diff", "--cached", "--name-only", "-z", "--no-renames", "--diff-filter=AM"])).stdout);
    const skipped: { path: string; size: number }[] = [];
    for (const p of staged) {
      const st = await fs.stat(path.join(this.opts.git.cwd, p)).catch(() => null);
      if (st && st.size > MAX_SYNC_BYTES) skipped.push({ path: p, size: st.size });
    }
    if (skipped.length) {
      const hasHead = Boolean(await revParse(g, "HEAD"));
      const paths = skipped.map((s) => s.path);
      await g(hasHead ? ["reset", "-q", "--", ...paths] : ["rm", "-q", "--cached", "--", ...paths]);
    }
    if (skipped.length || this.status.skipped.length) this.setStatus({ skipped });
  }

  private async fetch(): Promise<void> {
    await this.opts.git.run(["fetch", "--quiet", "--prune", this.opts.remote], { timeoutMs: this.opts.networkTimeoutMs });
  }

  private get remoteRef(): string {
    return `refs/remotes/${this.opts.remote}/${this.opts.branch}`;
  }

  private async mergePhase(): Promise<void> {
    await this.opts.worktreeLock.run(() =>
      this.opts.git.exclusive(async (g) => {
        // A note may have been saved while we were fetching.
        await this.commitLocal(g);
        if (!(await refExists(g, this.remoteRef))) return;
        const headBefore = await revParse(g, "HEAD");
        if (headBefore) {
          const behind = await count(g, `HEAD..${this.remoteRef}`);
          if (behind === 0) return;
        }
        // No rename detection: filenames never change, except moving a note to
        // the Trash. With rename detection, an edit made elsewhere would follow
        // the note into the Trash; without it, "edit wins over delete" keeps
        // the edited note in place (and the old version stays in the Trash).
        const args = ["merge", "--no-edit", "--quiet", "-X", "no-renames"];
        if (headBefore) args.push("--allow-unrelated-histories");
        args.push(this.remoteRef);
        const theirs = await revParse(g, this.remoteRef);
        const res = await g(args, { allowFail: true });
        if (res.code !== 0) {
          const unmerged = await g(["ls-files", "-u", "-z"]);
          if (!unmerged.stdout) {
            await this.abortMerge(g);
            throw new GitError("other", args, `Merge failed: ${(res.stderr || res.stdout).trim()}`, res);
          }
          try {
            await this.resolveConflicts(g, unmerged.stdout);
            await g(["commit", "--no-edit", "-q"]);
          } catch (err) {
            await this.abortMerge(g);
            throw new Error(`Conflict resolution failed and the merge was aborted; nothing was lost. ${(err as Error).message}`);
          }
        }
        if (headBefore && theirs) await this.keepEditedNotes(g, headBefore, theirs);
        const headAfter = await revParse(g, "HEAD");
        if (headAfter && headAfter !== headBefore) {
          const diffArgs = headBefore ? ["diff", "--name-only", "-z", headBefore, headAfter] : ["ls-files", "-z"];
          const changed = splitZ((await g(diffArgs)).stdout);
          this.emit("merged", changed);
        }
      }),
    );
  }

  /**
   * "An edit wins over a delete", whatever git's rename detection did: any
   * file modified on either side since the merge base that is missing after
   * the merge (e.g. git followed a move-to-Trash and put the edit in the
   * Trash copy) is brought back with that side's content.
   */
  private async keepEditedNotes(g: G, ours: string, theirs: string): Promise<void> {
    const base = (await g(["merge-base", ours, theirs], { allowFail: true })).stdout.trim();
    if (!base) return;
    const present = new Set(splitZ((await g(["ls-files", "-z"])).stdout));
    const restore = new Map<string, string>();
    for (const side of [ours, theirs]) {
      const modified = splitZ((await g(["diff", "--name-only", "-z", "--no-renames", "--diff-filter=M", base, side])).stdout);
      for (const p of modified) if (!present.has(p) && !restore.has(p)) restore.set(p, side);
    }
    if (!restore.size) return;
    for (const [p, side] of restore) await g(["checkout", side, "--", p]);
    await g(["commit", "-q", "-m", `auto: ${this.opts.now().toISOString()} ${this.opts.machineName} (kept ${restore.size} note${restore.size === 1 ? "" : "s"} edited elsewhere)`]);
  }

  private async abortMerge(g: G): Promise<void> {
    const r = await g(["merge", "--abort"], { allowFail: true });
    if (r.code !== 0) {
      // No merge in progress (or abort itself failed): surface it, never force.
      const gitDir = (await g(["rev-parse", "--absolute-git-dir"])).stdout.trim();
      if (await exists(path.join(gitDir, "MERGE_HEAD"))) {
        throw new Error(`Could not abort the merge: ${r.stderr.trim()}`);
      }
    }
  }

  /**
   * Conflict policy (HANDOVER 10.3). For each unmerged path:
   * - both sides have it (both modified, both added): keep ours in place,
   *   save theirs as a conflict copy.
   * - only ours has it (they deleted): keep ours.
   * - only theirs has it (we deleted): keep theirs.
   * - neither (both deleted after a rename): remove it.
   */
  private async resolveConflicts(g: G, lsFilesU: string): Promise<void> {
    const stages = new Map<string, Set<number>>();
    for (const entry of splitZ(lsFilesU)) {
      const tab = entry.indexOf("\t");
      const meta = entry.slice(0, tab).split(" ");
      const p = entry.slice(tab + 1);
      const stage = Number(meta[2]);
      if (!stages.has(p)) stages.set(p, new Set());
      stages.get(p)!.add(stage);
    }
    const repoRoot = this.opts.git.cwd;
    const taken = new Set(splitZ((await g(["ls-files", "-z"])).stdout));
    for (const [p, s] of stages) {
      await this.opts.hooks.duringResolve?.(p);
      const ours = s.has(2);
      const theirs = s.has(3);
      if (ours && theirs) {
        const host = await this.theirHost(g, p);
        const copy = await conflictCopyName(repoRoot, p, localDate(this.opts.now()), host, taken);
        taken.add(copy);
        // Check out their version (with the repo's eol/filters applied), copy it aside, then restore ours.
        await g(["checkout", "--theirs", "--", p]);
        await fs.copyFile(path.join(repoRoot, p), path.join(repoRoot, copy));
        await g(["checkout", "--ours", "--", p]);
        await g(["add", "--", p, copy]);
      } else if (ours) {
        await g(["checkout", "--ours", "--", p]);
        await g(["add", "--", p]);
      } else if (theirs) {
        await g(["checkout", "--theirs", "--", p]);
        await g(["add", "--", p]);
      } else {
        await g(["rm", "-q", "--cached", "--ignore-unmatch", "--", p]);
      }
    }
    const left = await g(["ls-files", "-u", "-z"]);
    if (left.stdout) throw new Error("Some paths are still unmerged after resolution.");
  }

  /** The machine name from the other side's last auto-commit touching `p`, if any. */
  private async theirHost(g: G, p: string): Promise<string> {
    const r = await g(["log", "-1", "--format=%s", "MERGE_HEAD", "--", p], { allowFail: true });
    const m = /^auto: \S+ (.+)$/.exec(r.stdout.trim());
    return sanitizeHost(m ? m[1] : "remote");
  }

  private async pushPhase(): Promise<void> {
    const { git, remote, branch, maxPushAttempts } = this.opts;
    for (let attempt = 1; ; attempt++) {
      const remoteKnown = await git.exclusive((g) => refExists(g, this.remoteRef));
      const ahead = await this.countAhead();
      if (ahead === 0) return;
      await this.opts.hooks.beforePush?.(attempt);
      const args = ["push", "--quiet"];
      if (!remoteKnown) args.push("-u");
      args.push(remote, `HEAD:refs/heads/${branch}`);
      try {
        // A successful push also updates refs/remotes/<remote>/<branch>.
        await git.run(args, { timeoutMs: this.opts.networkTimeoutMs });
        return;
      } catch (err) {
        if (err instanceof GitError && err.kind === "rejected" && attempt < maxPushAttempts) {
          await this.fetch();
          await this.mergePhase();
          continue;
        }
        if (err instanceof GitError && err.kind === "rejected") {
          throw new GitError("other", args, `Push was rejected ${attempt} times because the remote kept moving. Will retry on the next sync.`, err.result);
        }
        throw err;
      }
    }
  }

  private async countAhead(): Promise<number> {
    return this.opts.git.exclusive(async (g) => {
      if (!(await revParse(g, "HEAD"))) return 0;
      if (!(await refExists(g, this.remoteRef))) return count(g, "HEAD");
      return count(g, `${this.remoteRef}..HEAD`);
    });
  }

  private async listConflicts(): Promise<string[]> {
    const r = await this.opts.git.run(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
    return [...new Set(splitZ(r.stdout))].filter(isConflictCopy).sort();
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function refExists(g: G, ref: string): Promise<boolean> {
  return (await g(["rev-parse", "--verify", "-q", ref], { allowFail: true })).code === 0;
}

async function revParse(g: G, ref: string): Promise<string | null> {
  const r = await g(["rev-parse", "--verify", "-q", ref], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() : null;
}

async function count(g: G, range: string): Promise<number> {
  return Number((await g(["rev-list", "--count", range])).stdout.trim());
}

/** `notes/foo.md` -> `notes/foo (conflict 2026-11-27 laptop).md`, unique. */
export async function conflictCopyName(repoRoot: string, p: string, date: string, host: string, taken: Set<string>): Promise<string> {
  const ext = path.posix.extname(p) || ".md";
  const stem = p.slice(0, p.length - path.posix.extname(p).length);
  for (let i = 1; ; i++) {
    const candidate = `${stem} (conflict ${date} ${host})${i > 1 ? ` ${i}` : ""}${ext}`;
    if (!taken.has(candidate) && !(await exists(path.join(repoRoot, candidate)))) return candidate;
  }
}

/**
 * True if the file at `abs` holds exactly a version that `repoRel` had at
 * some point in git history (so it's an older copy, not separate edits).
 * Used when moving notes into Home/ finds a different copy already there.
 */
export async function isEarlierVersion(git: Git, repoRel: string, abs: string): Promise<boolean> {
  const blob = await git.run(["hash-object", "--", abs], { allowFail: true });
  if (blob.code !== 0) return false;
  const id = blob.stdout.trim();
  const log = await git.run(["log", "--no-renames", "--raw", "--no-abbrev", "--format=", "--", repoRel], { allowFail: true });
  if (log.code !== 0) return false;
  // Lines look like ":100644 100644 <old blob> <new blob> M\tpath".
  return log.stdout.split("\n").some((line) => {
    const f = line.split(/\s+/);
    return line.startsWith(":") && (f[2] === id || f[3] === id);
  });
}

/**
 * When to sync (HANDOVER 10.1): after saves once idle, on a timer, on focus
 * (rate limited), on demand, and once at shutdown with a timeout.
 */
export class SyncScheduler {
  private idleTimer: NodeJS.Timeout | null = null;
  private interval: NodeJS.Timeout | null = null;
  private lastFocusSync = 0;
  readonly engine: SyncEngine;
  readonly idleMs: number;
  readonly intervalMs: number;
  readonly focusMinGapMs: number;

  constructor(engine: SyncEngine, opts: { idleMs?: number; intervalMs?: number; focusMinGapMs?: number } = {}) {
    this.engine = engine;
    this.idleMs = opts.idleMs ?? 8_000;
    this.intervalMs = opts.intervalMs ?? 3 * 60_000;
    this.focusMinGapMs = opts.focusMinGapMs ?? 30_000;
  }

  start(): void {
    void this.engine.request();
    if (this.intervalMs > 0) {
      this.interval = setInterval(() => void this.engine.request(), this.intervalMs);
      this.interval.unref();
    }
  }

  /** A note was saved: sync once the editor has been idle for a while. */
  noteSaved(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.engine.request();
    }, this.idleMs);
    this.idleTimer.unref();
  }

  focus(): void {
    const now = Date.now();
    if (now - this.lastFocusSync < this.focusMinGapMs) return;
    this.lastFocusSync = now;
    void this.engine.request();
  }

  now(): Promise<SyncStatus> {
    return this.engine.request();
  }

  /** Final sync at quit, bounded so the app never hangs on close. */
  async shutdown(timeoutMs = 10_000): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.interval) clearInterval(this.interval);
    await Promise.race([this.engine.request(), new Promise((r) => setTimeout(r, timeoutMs).unref())]);
  }
}
