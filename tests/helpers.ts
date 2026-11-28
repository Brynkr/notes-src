// Test harness: a bare "remote" repo plus clones acting as machines, all in a
// temp folder. Never touches a real notes repo.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Git, Queue } from "../server/git.ts";
import { SyncEngine, type SyncHooks } from "../server/sync.ts";

// Isolate tests from the developer's own git config.
const globalCfg = path.join(os.tmpdir(), `notes-test-gitconfig-${process.pid}`);
fs.writeFileSync(
  globalCfg,
  "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n",
);
process.env.GIT_CONFIG_GLOBAL = globalCfg;
process.env.GIT_CONFIG_NOSYSTEM = "1";

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export async function tempDir(prefix: string): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

export interface Machine {
  name: string;
  dir: string;
  git: Git;
  engine: SyncEngine;
  lock: Queue;
  write(file: string, text: string): void;
  read(file: string): string;
  exists(file: string): boolean;
  rm(file: string): void;
  files(): string[];
  sync(): ReturnType<SyncEngine["request"]>;
}

export interface World {
  root: string;
  remote: string;
  machine(name: string, hooks?: SyncHooks, gitOpts?: ConstructorParameters<typeof Git>[1]): Machine;
  cleanup(): Promise<void>;
}

export async function makeWorld(): Promise<World> {
  const root = await tempDir("notes-sync-");
  const remote = path.join(root, "remote.git");
  sh(root, "init", "-q", "--bare", "-b", "main", remote);
  return {
    root,
    remote,
    machine(name, hooks = {}, gitOpts = {}) {
      const dir = path.join(root, name);
      if (!fs.existsSync(dir)) sh(root, "clone", "-q", remote, dir);
      const git = new Git(dir, gitOpts);
      const lock = new Queue();
      const engine = new SyncEngine({ git, remote: "origin", branch: "main", machineName: name, worktreeLock: lock, hooks, networkTimeoutMs: 60_000 /* local temp repos; generous so a busy PC isn't mistaken for offline */ });
      return {
        name,
        dir,
        git,
        engine,
        lock,
        write: (f, t) => {
          fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
          fs.writeFileSync(path.join(dir, f), t);
        },
        read: (f) => fs.readFileSync(path.join(dir, f), "utf8"),
        exists: (f) => fs.existsSync(path.join(dir, f)),
        rm: (f) => fs.rmSync(path.join(dir, f)),
        files: () =>
          fs
            .readdirSync(dir, { recursive: true, encoding: "utf8" })
            .filter((f) => !f.startsWith(".git") && fs.statSync(path.join(dir, f)).isFile())
            .sort(),
        sync: () => engine.request(),
      };
    },
    cleanup: () => fsp.rm(root, { recursive: true, force: true }),
  };
}

export function hasConflictMarkers(text: string): boolean {
  return /^(<{7}|={7}|>{7})( |$)/m.test(text);
}
