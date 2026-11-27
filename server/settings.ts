// Settings and first-run setup: validating input from the settings screen,
// testing a remote, cloning or adopting a notes folder, setting the remote.
// All git still goes through git.ts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Git, GitError } from "./git.ts";
import { DEFAULT_GITIGNORE } from "./runtime.ts";

export class SettingsError extends Error {}

/**
 * Accept the remote URL forms people actually use, and nothing that could
 * smuggle options or helper programs into git (e.g. "-u…", "ext::…").
 */
export function validateRemoteUrl(raw: string): string {
  const url = raw.trim();
  if (!url) throw new SettingsError("Enter the repository URL.");
  if (url.length > 500 || /\s/.test(url) || url.startsWith("-") || /^[a-z0-9+.-]+::/i.test(url)) {
    throw new SettingsError("That doesn't look like a git repository URL.");
  }
  const ok =
    /^https:\/\/[^/\s]+\/.+/i.test(url) ||
    /^ssh:\/\/[^/\s]+\/.+/i.test(url) ||
    /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^/\s].*/.test(url) || // git@github.com:you/notes.git
    /^file:\/\/\/.+/i.test(url) ||
    path.isAbsolute(url); // a bare repo on this machine (e.g. on the Pi)
  if (!ok) {
    throw new SettingsError("Use an HTTPS URL (https://github.com/you/notes.git), an SSH URL (git@github.com:you/notes.git), or a folder path.");
  }
  return url;
}

export function validateName(raw: unknown, what: string): string {
  const s = String(raw ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(s) || s.includes("..") || s.endsWith(".lock") || s.endsWith("/")) {
    throw new SettingsError(`${what} can only use letters, numbers, ".", "_", "-" and "/".`);
  }
  return s;
}

export function validateMachineName(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/.test(s)) throw new SettingsError("Machine name: up to 40 letters, numbers, spaces, '.', '_' or '-'.");
  return s;
}

export function validateFolder(raw: unknown): string {
  let s = String(raw ?? "").trim();
  if (!s) throw new SettingsError("Choose a folder for your notes.");
  if (s === "~" || s.startsWith("~/") || s.startsWith("~\\")) s = path.join(os.homedir(), s.slice(1));
  if (!path.isAbsolute(s)) throw new SettingsError("Use a full folder path, e.g. " + path.join(os.homedir(), "Notes"));
  return path.resolve(s);
}

export function validateNotesDir(raw: unknown): string {
  const s = String(raw ?? ".").trim() || ".";
  const norm = path.posix.normalize(s.replace(/\\/g, "/"));
  if (path.posix.isAbsolute(norm) || norm.startsWith("..") || norm.split("/").some((seg) => seg.startsWith(".") && seg !== ".")) {
    throw new SettingsError("Notes subfolder must be a folder inside the repo, like notes or . for the top level.");
  }
  return norm;
}

export function validateSeconds(raw: unknown, what: string, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new SettingsError(`${what} must be between ${min} and ${max}.`);
  return Math.round(n);
}

export function validateHosts(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : String(raw ?? "").split(/[\s,]+/);
  const hosts = list.map((h) => String(h).trim().toLowerCase()).filter(Boolean);
  for (const h of hosts) {
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(h) || h.length > 253) {
      throw new SettingsError(`"${h}" isn't a valid host name.`);
    }
  }
  return [...new Set(hosts)];
}

function explain(err: unknown): string {
  if (err instanceof GitError) {
    if (err.kind === "auth") {
      return "This computer isn't allowed to access that repository. Check the URL, then make sure git can push to it from a terminal (SSH key added to GitHub, or signed in with Git Credential Manager).";
    }
    if (err.kind === "network") return "Couldn't reach the server. Check the URL and your internet connection.";
    if (err.kind === "missing-git") return "git isn't installed or isn't on the PATH.";
    if (/not found|does not appear to be a git repository|repository .* not found/i.test(err.message)) {
      return "No repository at that address (or this computer can't see it). Check the URL.";
    }
    return err.message;
  }
  return (err as Error).message;
}

export interface RemoteTest {
  ok: boolean;
  message: string;
  empty?: boolean;
  branches?: string[];
}

/**
 * Check that git can read the remote. `interactive` lets Git Credential
 * Manager show its sign-in window (desktop only).
 */
export async function testRemote(url: string, interactive: boolean): Promise<RemoteTest> {
  const valid = validateRemoteUrl(url);
  const git = new Git(os.tmpdir());
  try {
    const r = await git.run(["ls-remote", "--heads", valid], { timeoutMs: interactive ? 180_000 : 30_000, interactiveAuth: interactive });
    const branches = r.stdout
      .split("\n")
      .map((l) => l.split("\t")[1]?.replace(/^refs\/heads\//, ""))
      .filter((b): b is string => Boolean(b));
    return {
      ok: true,
      empty: branches.length === 0,
      branches,
      message: branches.length ? `Connected. Branches: ${branches.join(", ")}.` : "Connected. The repository is empty, which is fine for a fresh start.",
    };
  } catch (err) {
    return { ok: false, message: explain(err) };
  }
}

/** The URL as configured (not after any url.insteadOf rewriting). */
export async function getRemoteUrl(repoRoot: string, remote: string): Promise<string | null> {
  const r = await new Git(repoRoot).run(["config", "--get", `remote.${remote}.url`], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function setRemoteUrl(repoRoot: string, remote: string, url: string | null): Promise<void> {
  const git = new Git(repoRoot);
  const current = await getRemoteUrl(repoRoot, remote);
  if (url === null || url === "") {
    if (current !== null) await git.run(["remote", "remove", remote]);
    return;
  }
  const valid = validateRemoteUrl(url);
  if (current === valid) return;
  await git.run(current === null ? ["remote", "add", remote, valid] : ["remote", "set-url", remote, valid]);
}

function isEmptyDir(p: string): boolean {
  try {
    return fs.readdirSync(p).length === 0;
  } catch {
    return true; // missing counts as empty
  }
}

/**
 * First-run setup. Missing or empty folder + URL: clone it. Otherwise adopt
 * the folder (git init if needed) and set the remote; the first sync merges
 * whatever is on the remote.
 */
export async function setupRepo(opts: { repoPath: string; remoteUrl: string | null; remote: string; branch: string; interactive: boolean }): Promise<string> {
  const { repoPath, remote, branch } = opts;
  const url = opts.remoteUrl ? validateRemoteUrl(opts.remoteUrl) : null;
  if (url && isEmptyDir(repoPath)) {
    const parent = path.dirname(repoPath);
    fs.mkdirSync(parent, { recursive: true });
    if (fs.existsSync(repoPath)) fs.rmdirSync(repoPath); // empty: let clone create it
    try {
      await new Git(parent).run(["clone", "--quiet", "--origin", remote, url, repoPath], {
        timeoutMs: opts.interactive ? 300_000 : 120_000,
        interactiveAuth: opts.interactive,
      });
    } catch (err) {
      fs.mkdirSync(repoPath, { recursive: true });
      throw new SettingsError(explain(err));
    }
    const git = new Git(repoPath);
    // An empty remote clones onto an unborn default branch; make sure it's ours.
    const head = await git.run(["symbolic-ref", "--short", "HEAD"], { allowFail: true });
    if (head.stdout.trim() !== branch) {
      const hasCommits = (await git.run(["rev-parse", "--verify", "-q", "HEAD"], { allowFail: true })).code === 0;
      if (!hasCommits) await git.run(["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
      else if ((await git.run(["rev-parse", "--verify", "-q", `refs/remotes/${remote}/${branch}`], { allowFail: true })).code === 0) {
        await git.run(["checkout", "-q", "-B", branch, `${remote}/${branch}`]);
      }
    }
    if (!fs.existsSync(path.join(repoPath, ".gitignore"))) fs.writeFileSync(path.join(repoPath, ".gitignore"), DEFAULT_GITIGNORE);
    return "Cloned your notes repository.";
  }

  fs.mkdirSync(repoPath, { recursive: true });
  const git = new Git(repoPath);
  const top = await git.run(["rev-parse", "--show-toplevel"], { allowFail: true });
  let message: string;
  if (top.code !== 0) {
    const stray = nonNoteFiles(repoPath);
    if (stray.length) {
      throw new SettingsError(
        `That folder already has other files in it (${stray.slice(0, 3).join(", ")}${stray.length > 3 ? ", …" : ""}). ` +
          "Everything in the notes folder gets synced to GitHub, so choose an empty folder or one that only holds notes.",
      );
    }
    await git.run(["init", "-q", "-b", branch]);
    if (!fs.existsSync(path.join(repoPath, ".gitignore"))) fs.writeFileSync(path.join(repoPath, ".gitignore"), DEFAULT_GITIGNORE);
    message = "Created a new notes folder.";
  } else {
    message = "Using the existing git repository in that folder.";
  }
  if (url) {
    const root = top.code === 0 ? top.stdout.trim() : repoPath;
    await setRemoteUrl(root, remote, url);
    message += " Your notes will sync with the remote.";
  }
  return message;
}

/** Files that aren't notes (Markdown or text), so we never turn e.g. Documents into a repo. */
export function nonNoteFiles(dir: string, limit = 20): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string, depth: number) => {
    if (out.length >= limit || depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (e.name.startsWith(".") || e.name === "Thumbs.db" || e.name === "desktop.ini") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r, depth + 1);
      else if (!/\.(md|markdown|txt)$/i.test(e.name)) out.push(r);
    }
  };
  walk(dir, "", 0);
  return out;
}

export function defaultRepoPath(): string {
  return path.join(os.homedir(), "Notes");
}
