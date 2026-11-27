// Smoke test for the portable executable built by `npm run exe`.
// Run it by hand on the OS you built for:
//
//   npm run exe && npm run test:exe
//
// It copies the exe into a temp folder, double-click-launches it (no
// command), checks the embedded web UI and the portable Notes-data folder,
// runs first-run setup against a scratch bare repo, creates a note, syncs,
// checks the push landed, then stops it. Uses port 4799 and an isolated git
// config, so it doesn't touch a running Notes or your real notes.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const WIN = process.platform === "win32";
const PORT = 4799;
const BASE = `http://127.0.0.1:${PORT}`;
const built = path.resolve("release", WIN ? "Notes.exe" : "notes");
if (!fs.existsSync(built)) fail(`${built} not found; run "npm run exe" first`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "notes-exe-test-"));
const exe = path.join(tmp, "portable", path.basename(built));
fs.mkdirSync(path.dirname(exe));
fs.copyFileSync(built, exe);
fs.chmodSync(exe, 0o755);

const gitConfig = path.join(tmp, "gitconfig");
fs.writeFileSync(gitConfig, "[user]\n\tname = Notes Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n");
const env = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
delete env.NOTES_APP_CONFIG_DIR;
delete env.NOTES_APP_DATA_DIR;
const git = (...args) => execFileSync("git", args, { env, encoding: "utf8" }).trim();
const run = (args) =>
  new Promise((resolve) => spawn(exe, args, { env, stdio: "ignore", windowsHide: true }).on("exit", resolve));

let started = false;
try {
  if (WIN) {
    const b = fs.readFileSync(exe);
    const pe = b.readUInt32LE(0x3c);
    check(b.readUInt16LE(pe + 24 + 68) === 2, "exe is a windowed app (no console)");
  }

  // Like a double-click: no command.
  await run(["--port", String(PORT), "--no-window"]);
  started = true;
  const info = await waitFor(() => api("GET", "/api/info"), 20_000);
  check(info && info.configured === false, "starts in first-run setup");
  const html = await (await fetch(`${BASE}/`)).text();
  check(html.includes("app.js"), "web UI served from inside the exe");
  check((await fetch(`${BASE}/app.js`)).ok, "app.js served");
  check(fs.existsSync(path.join(tmp, "portable", "Notes-data", "data", "notes-app.log")), "uses the portable Notes-data folder");

  const remote = path.join(tmp, "remote.git");
  git("init", "-q", "--bare", "-b", "main", remote);
  await api("POST", "/api/setup", { repoPath: path.join(tmp, "MyNotes"), remoteUrl: remote, machineName: "exe-test" });
  await api("POST", "/api/notes", { title: "Hello from the exe" });
  const status = await api("POST", "/api/sync", {});
  check(status.state === "synced", `sync state is synced (got ${status.state}${status.message ? `: ${status.message}` : ""})`);
  check(/hello-from-the-exe/.test(git("-C", remote, "ls-tree", "--name-only", "main")), "note pushed to the remote");

  await run(["stop", "--port", String(PORT)]);
  const gone = await waitFor(async () => ((await api("GET", "/api/info").catch(() => null)) ? null : true), 15_000);
  check(gone, "stops");
  started = false;
  console.log(`\nAll good: ${path.basename(built)} (${(fs.statSync(built).size / 1048576).toFixed(1)} MB)`);
} catch (err) {
  const log = path.join(tmp, "portable", "Notes-data", "data", "notes-app.log");
  if (fs.existsSync(log)) console.error(`--- notes-app.log ---\n${fs.readFileSync(log, "utf8")}`);
  fail(err.message);
} finally {
  if (started) await run(["stop", "--port", String(PORT)]);
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch {
    /* Windows may still hold a file briefly */
  }
}

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { "X-Notes-App": "1", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${data?.error ?? ""}`);
  return data;
}

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

function check(ok, what) {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`ok  ${what}`);
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}
