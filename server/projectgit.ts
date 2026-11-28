// Git for IDE mode's outside folders that are git repositories: branch,
// changed files, commit chosen files, pull (fast-forward only) and push.
//
// Safety: nothing here resets, cleans, rebases, merges or force-pushes.
// A pull that isn't a fast-forward is refused with an explanation, so the
// owner's project never ends up mid-merge because of this app. Every git
// call goes through Git (server/git.ts) like everywhere else.

import path from "node:path";
import type { ChangeEntry, ProjectGitStatus } from "../shared/types.ts";
import { isTextFile } from "../shared/files.ts";
import { Git, GitError } from "./git.ts";

export class ProjectGitError extends Error {}

const NUL = String.fromCharCode(0);

/** Git for one outside folder. `create` returns null when the folder isn't inside a git work tree. */
export class ProjectGit {
  readonly git: Git;
  /** The folder's path inside its repository ("" when the folder is the repository root). */
  private readonly prefix: string;

  private constructor(top: string, folder: string) {
    this.git = new Git(top);
    this.prefix = path.relative(top, folder).split(path.sep).join("/");
  }

  static async create(folder: string): Promise<ProjectGit | null> {
    const r = await new Git(folder).run(["rev-parse", "--show-toplevel"], { allowFail: true });
    if (r.code !== 0) return null;
    return new ProjectGit(path.resolve(r.stdout.trim()), path.resolve(folder));
  }

  /** Folder-relative path → repository-relative, and back (null if outside the folder). */
  private toRepo(rel: string): string {
    return this.prefix ? `${this.prefix}/${rel}` : rel;
  }
  private fromRepo(repoPath: string): string | null {
    if (!this.prefix) return repoPath;
    return repoPath.startsWith(this.prefix + "/") ? repoPath.slice(this.prefix.length + 1) : null;
  }

  async status(): Promise<Omit<ProjectGitStatus, "id">> {
    const branch = (await this.git.run(["rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true })).stdout.trim() || null;
    const upstreamR = await this.git.run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { allowFail: true });
    const upstream = upstreamR.code === 0 ? upstreamR.stdout.trim() : null;
    let ahead = 0;
    let behind = 0;
    if (upstream) {
      const c = await this.git.run(["rev-list", "--left-right", "--count", "@{u}...HEAD"], { allowFail: true });
      const [b, a] = c.stdout.trim().split(/\s+/).map(Number);
      behind = b || 0;
      ahead = a || 0;
    }
    const s = await this.git.run(["-c", "core.quotepath=false", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", "."], { allowFail: true });
    const changes: ChangeEntry[] = [];
    for (const entry of s.stdout.split(NUL)) {
      if (entry.length < 4) continue;
      const xy = entry.slice(0, 2);
      const rel = this.fromRepo(entry.slice(3));
      if (!rel || !isTextFile(rel) || rel.split("/").some((p) => p.startsWith("."))) continue;
      const st = xy === "??" ? "A" : xy.includes("D") ? "D" : xy.includes("A") ? "A" : "M";
      changes.push({ path: rel, status: st });
    }
    changes.sort((a, b) => (a.path < b.path ? -1 : 1));
    return { repo: true, branch, upstream, ahead, behind, changes };
  }

  /** A file's text at HEAD (for diffs); null if it isn't committed. */
  async fileAtHead(rel: string): Promise<string | null> {
    const r = await this.git.run(["cat-file", "blob", `HEAD:${this.toRepo(rel)}`], { binary: true, allowFail: true });
    return r.code === 0 ? Buffer.from(r.stdout, "latin1").toString("utf8") : null;
  }

  /**
   * Commit exactly the chosen files (folder-relative), as they are on disk.
   * Anything the owner staged elsewhere for other files is left staged.
   */
  async commit(message: string, rels: string[]): Promise<string> {
    const msg = message.trim();
    if (!msg) throw new ProjectGitError("Write a commit message first.");
    if (!rels.length) throw new ProjectGitError("Tick at least one file to commit.");
    const changed = new Map((await this.status()).changes.map((c) => [c.path, c.status]));
    for (const r of rels) if (!changed.has(r)) throw new ProjectGitError(`${r} has no changes to commit.`);
    return this.git.exclusive(async (g) => {
      const paths = rels.map((r) => this.toRepo(r));
      // New files must be added first; "commit -- paths" then commits just these paths.
      const untracked = rels.filter((r) => changed.get(r) === "A").map((r) => this.toRepo(r));
      if (untracked.length) await g(["add", "--", ...untracked]);
      const r = await g(["commit", "-q", "-m", msg, "--", ...paths], { allowFail: true });
      if (r.code !== 0) throw new ProjectGitError(`git commit failed: ${(r.stderr || r.stdout).trim()}`);
      return (await g(["rev-parse", "--short", "HEAD"])).stdout.trim();
    });
  }

  /** Pull, fast-forward only: never a merge, never conflicts. */
  async pull(): Promise<string> {
    try {
      const r = await this.git.run(["pull", "--ff-only", "--no-rebase"], { timeoutMs: 60_000, interactiveAuth: true, allowFail: true });
      if (r.code === 0) return /Already up to date/i.test(r.stdout) ? "Already up to date." : "Pulled.";
      const err = (r.stderr || r.stdout).trim();
      if (/not possible to fast-forward|diverging|divergent/i.test(err)) {
        throw new ProjectGitError("Your branch and the remote have both changed, so it can't simply fast-forward. Merge or rebase in a terminal (Notes won't do that for you).");
      }
      if (/no tracking information|no upstream/i.test(err)) throw new ProjectGitError("This branch isn't tracking a remote branch yet. Push it first.");
      if (/would be overwritten/i.test(err)) throw new ProjectGitError("Pulling would overwrite uncommitted changes. Commit them first.");
      throw new ProjectGitError(`git pull failed: ${err}`);
    } catch (e) {
      if (e instanceof GitError) throw new ProjectGitError(`git pull failed: ${e.message}`);
      throw e;
    }
  }

  /** Push the current branch (setting its upstream the first time). Never forced. */
  async push(): Promise<string> {
    const branch = (await this.git.run(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    if (!branch || branch === "HEAD") throw new ProjectGitError("Not on a branch (detached HEAD); switch to a branch in a terminal first.");
    const hasUpstream = (await this.git.run(["rev-parse", "--abbrev-ref", "@{u}"], { allowFail: true })).code === 0;
    const remote = (await this.git.run(["remote"], { allowFail: true })).stdout.split(/\s+/).filter(Boolean);
    if (!hasUpstream && !remote.length) throw new ProjectGitError("This repository has no remote to push to.");
    const args = hasUpstream ? ["push"] : ["push", "-u", remote.includes("origin") ? "origin" : remote[0], branch];
    try {
      const r = await this.git.run(args, { timeoutMs: 60_000, interactiveAuth: true, allowFail: true });
      if (r.code === 0) return "Pushed.";
      const err = (r.stderr || r.stdout).trim();
      if (/\[rejected\]|fetch first|non-fast-forward/i.test(err)) throw new ProjectGitError("The remote has commits you don't have. Pull first.");
      throw new ProjectGitError(`git push failed: ${err}`);
    } catch (e) {
      if (e instanceof GitError) throw new ProjectGitError(`git push failed: ${e.message}`);
      throw e;
    }
  }
}
