// Thin wrapper over the system `git` binary.
//
// Every git command in the app goes through `Git.run`, which is serialised by a
// single queue, so two git processes never touch the same repo at once (no
// index.lock errors). Nothing else in the codebase may spawn git.

import { spawn } from "node:child_process";
import os from "node:os";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitErrorKind = "network" | "auth" | "missing-git" | "rejected" | "other";

export class GitError extends Error {
  readonly kind: GitErrorKind;
  readonly args: string[];
  readonly result?: GitResult;
  constructor(kind: GitErrorKind, args: string[], message: string, result?: GitResult) {
    super(message);
    this.kind = kind;
    this.args = args;
    this.result = result;
  }
}

/** A promise-chain mutex. `run` executes jobs strictly one after another. */
export class Queue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(job, job);
    // Keep the chain alive whether the job succeeds or fails.
    this.tail = next.catch(() => undefined);
    return next;
  }
}

const AUTH_PATTERNS = [
  /permission denied \(publickey/i,
  /authentication failed/i,
  /could not read username/i,
  /could not read password/i,
  /invalid username or password/i,
  /the requested url returned error: 40[13]/i,
  /host key verification failed/i,
  /terminal prompts disabled/i,
];

const NETWORK_PATTERNS = [
  /could not resolve host/i,
  /could not resolve hostname/i,
  /connection refused/i,
  /connection timed out/i,
  /operation timed out/i,
  /connection reset/i,
  /network is unreachable/i,
  /no route to host/i,
  /failed to connect/i,
  /temporary failure in name resolution/i,
  /could not read from remote repository/i,
  /unable to access/i,
  /timed out after/i,
];

// "Remote moved under us": a normal non-fast-forward rejection, or losing a
// race with another push that landed at the same instant.
const REJECTED_PATTERNS = [
  /\[rejected\]/,
  /\(fetch first\)/i,
  /\(non-fast-forward\)/i,
  /cannot lock ref/i,
  /\(failed to update ref\)/i,
  /incorrect old value/i,
];

export function classifyGitError(stderr: string): GitErrorKind {
  if (AUTH_PATTERNS.some((re) => re.test(stderr))) return "auth";
  if (REJECTED_PATTERNS.some((re) => re.test(stderr))) return "rejected";
  if (NETWORK_PATTERNS.some((re) => re.test(stderr))) return "network";
  return "other";
}

export interface RunOptions {
  /** Kill the process after this many milliseconds. */
  timeoutMs?: number;
  /** Return the result instead of throwing on a non-zero exit code. */
  allowFail?: boolean;
  /** Return stdout as raw bytes (for blobs). */
  binary?: boolean;
}

export interface GitOptions {
  /** Default timeout for local commands. Network commands pass their own. */
  timeoutMs?: number;
  /** Test hook: called around every git invocation. */
  onSpawn?: (args: string[]) => void;
  onExit?: (args: string[]) => void;
}

export class Git {
  readonly cwd: string;
  readonly queue = new Queue();
  private identityEnv: Record<string, string> | null = null;
  private readonly opts: GitOptions;

  constructor(cwd: string, opts: GitOptions = {}) {
    this.cwd = cwd;
    this.opts = opts;
  }

  /** Run git, serialised with every other git call on this repo. */
  run(args: string[], options: RunOptions = {}): Promise<GitResult> {
    return this.queue.run(() => this.exec(args, options));
  }

  /**
   * Run several git calls as one uninterrupted unit. Inside `job`, use the
   * provided `git` function: calling `this.run` from inside would deadlock.
   */
  exclusive<T>(job: (git: (args: string[], options?: RunOptions) => Promise<GitResult>) => Promise<T>): Promise<T> {
    return this.queue.run(() => job((args, options = {}) => this.exec(args, options)));
  }

  /** Raw spawn. Not serialised: only call from inside the queue. */
  private async exec(args: string[], options: RunOptions): Promise<GitResult> {
    const env: Record<string, string | undefined> = {
      ...process.env,
      // Never block waiting for a password prompt: fail fast instead.
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      // Stable, parseable English output.
      LC_ALL: "C",
      LANG: "C",
      ...(await this.identity()),
    };
    const timeoutMs = options.timeoutMs ?? this.opts.timeoutMs ?? 30_000;
    this.opts.onSpawn?.(args);
    try {
      return await new Promise<GitResult>((resolve, reject) => {
        let child;
        try {
          child = spawn("git", args, { cwd: this.cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        } catch (err) {
          reject(new GitError("missing-git", args, `Could not start git: ${(err as Error).message}`));
          return;
        }
        const out: Buffer[] = [];
        const errChunks: Buffer[] = [];
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs);
        child.stdout.on("data", (d: Buffer) => out.push(d));
        child.stderr.on("data", (d: Buffer) => errChunks.push(d));
        child.on("error", (err: NodeJS.ErrnoException) => {
          clearTimeout(timer);
          const kind: GitErrorKind = err.code === "ENOENT" ? "missing-git" : "other";
          const msg = kind === "missing-git" ? "git is not installed or not on PATH" : err.message;
          reject(new GitError(kind, args, msg));
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          const stdoutBuf = Buffer.concat(out);
          const result: GitResult = {
            code: code ?? -1,
            stdout: options.binary ? stdoutBuf.toString("latin1") : stdoutBuf.toString("utf8"),
            stderr: Buffer.concat(errChunks).toString("utf8"),
          };
          if (timedOut) {
            result.stderr += `\ngit ${args[0]} timed out after ${timeoutMs} ms`;
            reject(new GitError("network", args, `git ${args[0]} timed out after ${timeoutMs} ms`, result));
            return;
          }
          if (result.code !== 0 && !options.allowFail) {
            const msg = (result.stderr || result.stdout).trim() || `git ${args.join(" ")} exited with ${result.code}`;
            reject(new GitError(classifyGitError(result.stderr), args, msg, result));
            return;
          }
          resolve(result);
        });
      });
    } finally {
      this.opts.onExit?.(args);
    }
  }

  /** Raw bytes of a blob, e.g. `:2:path` or `origin/main:path`. Only call inside the queue. */
  static async blob(git: (args: string[], o?: RunOptions) => Promise<GitResult>, spec: string): Promise<Buffer> {
    const r = await git(["cat-file", "blob", spec], { binary: true });
    return Buffer.from(r.stdout, "latin1");
  }

  /**
   * If this machine has no git identity configured, commits would fail. In that
   * case supply a fallback identity through the environment (never written to
   * git config).
   */
  private async identity(): Promise<Record<string, string>> {
    if (this.identityEnv) return this.identityEnv;
    this.identityEnv = {}; // set before probing so the probes below don't recurse
    const probe = (key: string) =>
      new Promise<string>((resolve) => {
        const c = spawn("git", ["config", key], { cwd: this.cwd, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
        let s = "";
        c.stdout.on("data", (d: Buffer) => (s += d.toString()));
        c.on("error", () => resolve(""));
        c.on("close", () => resolve(s.trim()));
      });
    const [name, email] = await Promise.all([probe("user.name"), probe("user.email")]);
    const host = os.hostname() || "machine";
    const env: Record<string, string> = {};
    if (!name) {
      env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = `notes-app (${host})`;
    }
    if (!email) {
      env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = `notes-app@${host}.local`;
    }
    this.identityEnv = env;
    return env;
  }
}

/** Parse NUL-separated output into non-empty entries. */
export function splitZ(s: string): string[] {
  return s.split("\0").filter((x) => x.length > 0);
}
