// Entry point: wires config, git, notes, watcher, search, sync and HTTP.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import type { SyncStatusDto } from "../shared/types.ts";
import { VERSION } from "../shared/version.ts";
import {
  configFile,
  dataDir,
  defaults,
  hashPassword,
  HELP,
  isLoopback,
  loadConfigFile,
  parseArgs,
  saveConfigFile,
  type Config,
} from "./config.ts";
import { Git, Queue } from "./git.ts";
import { createApp } from "./http.ts";
import { NoteStore } from "./notes.ts";
import { SearchIndex } from "./search.ts";
import { SyncEngine, SyncScheduler } from "./sync.ts";
import { NoteWatcher } from "./watcher.ts";

const DEFAULT_GITIGNORE = `# Written by notes-app. Edit freely.
.DS_Store
Thumbs.db
desktop.ini
*.tmp
*.swp
`;

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.command === "help") return void process.stdout.write(HELP);
  if (cli.command === "version") return void console.log(VERSION);

  const fileCfg = loadConfigFile();
  if (cli.command === "set-password") {
    const pw = await promptHidden("New password: ");
    if (pw.length < 8) throw new Error("Use at least 8 characters.");
    const again = await promptHidden("Repeat password: ");
    if (pw !== again) throw new Error("Passwords did not match.");
    saveConfigFile({ ...fileCfg, passwordHash: hashPassword(pw) });
    return void console.log(`Password saved (as a hash) in ${configFile()}`);
  }
  if (cli.command === "clear-password") {
    delete fileCfg.passwordHash;
    saveConfigFile(fileCfg);
    return void console.log("Password removed.");
  }

  if (cli.save) {
    saveConfigFile({ ...fileCfg, ...cli.overrides });
    console.log(`Saved settings to ${configFile()}`);
  }
  const cfg: Config = { ...defaults(), ...fileCfg, ...cli.overrides };
  if (!cfg.repoPath) {
    throw new Error(`No notes repo configured.\nRun once with:  notes-app --repo /path/to/notes --save\n(or edit ${configFile()})`);
  }
  if (!isLoopback(cfg.host) && !cfg.passwordHash && !cli.allowNoPassword) {
    throw new Error(`Listening on ${cfg.host} makes your notes reachable from other machines.\nSet a password first:  notes-app set-password\n(or pass --allow-no-password if you really mean it)`);
  }

  const repoRoot = await ensureRepo(cfg);
  const notesRoot = path.resolve(cfg.repoPath, cfg.notesDir);
  fs.mkdirSync(notesRoot, { recursive: true });
  const notesPrefix = path.relative(repoRoot, notesRoot).split(path.sep).join("/");

  const git = new Git(repoRoot);
  const worktreeLock = new Queue();
  const store = new NoteStore({ root: notesRoot, worktreeLock, machineName: cfg.machineName });

  // Search index: disposable, per notes folder, in the app-data directory.
  const indexFile = path.join(dataDir(), "index", createHash("sha256").update(notesRoot).digest("hex").slice(0, 16) + ".sqlite");
  const search = new SearchIndex(indexFile);
  await store.scan();
  const indexed = search.indexed();
  for (const [p, k] of store.known) {
    if (indexed.get(p) !== k.hash) reindex(p);
  }
  for (const p of indexed.keys()) if (!store.known.has(p)) search.remove(p);

  function reindex(p: string): void {
    const k = store.known.get(p);
    if (!k) return search.remove(p);
    try {
      search.upsert(p, k.hash, fs.readFileSync(store.resolve(p), "utf8"));
    } catch {
      /* deleted in the meantime: the watcher will report it */
    }
  }

  const engine = new SyncEngine({ git, remote: cfg.remote, branch: cfg.branch, machineName: cfg.machineName, worktreeLock });
  const scheduler = new SyncScheduler(engine, { idleMs: cfg.syncIdleSeconds * 1000, intervalMs: cfg.syncIntervalSeconds * 1000 });
  const watcher = new NoteWatcher(store);

  function status(): SyncStatusDto {
    const s = engine.status;
    const conflicts = [...store.known.values()].filter((k) => k.meta.conflict).map((k) => k.meta.path).sort();
    let state: SyncStatusDto["state"] = cfg.sync ? s.state : "disabled";
    if (state === "synced" && conflicts.length) state = "conflict";
    if (state === "conflict" && !conflicts.length) state = "synced";
    return {
      state,
      lastSyncMs: s.lastSyncMs,
      lastAttemptMs: s.lastAttemptMs,
      message: cfg.sync ? s.message : "Sync is turned off (--no-sync).",
      conflicts,
      ahead: s.ahead,
    };
  }

  const app = createApp({
    store,
    search,
    status,
    info: { machineName: cfg.machineName, repoPath: repoRoot, notesDir: cfg.notesDir, remote: cfg.remote, branch: cfg.branch, version: VERSION },
    syncNow: async () => {
      if (cfg.sync) await scheduler.now();
      return status();
    },
    onFocus: () => cfg.sync && scheduler.focus(),
    onSaved: (paths) => {
      for (const p of paths) reindex(p);
      if (cfg.sync) scheduler.noteSaved();
      app.broadcast({ type: "status", status: status() });
    },
    host: cfg.host,
    passwordHash: cfg.passwordHash,
    webDir: path.join(path.dirname(fileURLToPath(import.meta.url)), "web"),
  });

  watcher.on("changed", (paths) => {
    for (const p of paths) {
      reindex(p);
      const k = store.known.get(p);
      if (k) app.broadcast({ type: "note-changed", path: p, hash: k.hash });
    }
    app.broadcast({ type: "notes-changed" });
    app.broadcast({ type: "status", status: status() });
  });
  watcher.on("deleted", (paths) => {
    for (const p of paths) {
      search.remove(p);
      app.broadcast({ type: "note-deleted", path: p });
    }
    app.broadcast({ type: "notes-changed" });
    app.broadcast({ type: "status", status: status() });
  });
  engine.on("status", () => app.broadcast({ type: "status", status: status() }));
  engine.on("merged", (repoPaths: string[]) => {
    const prefix = notesPrefix ? notesPrefix + "/" : "";
    watcher.poke(repoPaths.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length)));
  });

  watcher.start();
  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(cfg.port, cfg.host, resolve);
  });
  const shownHost = isLoopback(cfg.host) ? "localhost" : cfg.host === "0.0.0.0" ? "<this-machine's-address>" : cfg.host;
  const url = `http://${shownHost}:${cfg.port}/`;
  console.log(`notes-app ${VERSION}`);
  console.log(`  notes:  ${notesRoot}`);
  console.log(`  sync:   ${cfg.sync ? `${cfg.remote}/${cfg.branch} as "${cfg.machineName}"` : "off"}`);
  console.log(`  open:   ${url}${cfg.passwordHash ? "  (password required)" : ""}`);
  if (cfg.sync) scheduler.start();
  if (cli.open && isLoopback(cfg.host)) openBrowser(url);

  let stopping = false;
  const stop = async () => {
    if (stopping) process.exit(1); // second Ctrl+C: leave now
    stopping = true;
    console.log("Shutting down: final sync (up to 10 s)…");
    watcher.stop();
    app.server.close();
    app.closeClients();
    if (cfg.sync) await scheduler.shutdown(10_000);
    search.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

/** Make sure repoPath is inside a git work tree; create one if the folder is new. Returns the repo root. */
async function ensureRepo(cfg: Config): Promise<string> {
  fs.mkdirSync(cfg.repoPath, { recursive: true });
  const probe = new Git(cfg.repoPath);
  const top = await probe.run(["rev-parse", "--show-toplevel"], { allowFail: true });
  if (top.code === 0) return path.resolve(top.stdout.trim());
  await probe.run(["init", "-q", "-b", cfg.branch]);
  const gi = path.join(cfg.repoPath, ".gitignore");
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, DEFAULT_GITIGNORE);
  console.log(`Created a new git repo in ${cfg.repoPath}. Add a remote to sync:  git -C "${cfg.repoPath}" remote add ${cfg.remote} <url>`);
  return path.resolve(cfg.repoPath);
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args as string[], { detached: true, stdio: "ignore", windowsHide: true }).on("error", () => undefined).unref();
  } catch {
    /* no browser: the URL is printed above */
  }
}

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    let asked = false;
    // Echo the question but not the typed characters.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (!asked) {
        process.stdout.write(s);
        asked = true;
      }
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

main().catch((err: Error) => {
  console.error(`notes-app: ${err.message}`);
  process.exit(1);
});
