// A second copy of the server started while one is running must fail on the
// port having changed nothing: not the notes folder (no sync, no moves into
// Home/) and not the control token that `notes-app stop` relies on.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { tempDir } from "../helpers.ts";

const PORT = 4788;
const MAIN = path.resolve("server/main.ts");
// Run the .ts entry point the same way this test runs (type stripping flags included).
const nodeArgs = process.execArgv.filter((a) => !a.startsWith("--test"));

function start(env: NodeJS.ProcessEnv, args: string[]): { child: ChildProcess; out: () => string; exited: Promise<number | null> } {
  const child = spawn(process.execPath, [...nodeArgs, MAIN, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  return { child, out: () => out, exited };
}

async function until(ok: () => boolean, what: string, ms = 20_000): Promise<void> {
  const t0 = Date.now();
  while (!ok()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("a second copy on the same port fails without touching the notes or the stop token", async () => {
  const root = await tempDir("notes-single-");
  const repo = path.join(root, "notes");
  const env = { ...process.env, NOTES_APP_CONFIG_DIR: path.join(root, "c"), NOTES_APP_DATA_DIR: path.join(root, "d") };
  const args = ["--repo", repo, "--no-sync", "--port", String(PORT)];
  const tokenFile = path.join(root, "d", `control-${PORT}.token`);

  const a = start(env, args);
  try {
    await until(() => a.out().includes("open:"), "first copy listening");
    const token = fs.readFileSync(tokenFile, "utf8");
    // A note at the root: the first copy has already done its startup move, a second copy would move this.
    fs.writeFileSync(path.join(repo, "late.md"), "# Late\n");

    const b = start(env, args);
    const code = await Promise.race([b.exited, new Promise<null>((r) => setTimeout(() => r(null), 15_000))]);
    assert.notEqual(code, 0, `second copy should fail; output:\n${b.out()}`);
    assert.match(b.out(), /already in use by another copy of Notes\. Nothing was changed/);
    assert.equal(fs.existsSync(path.join(repo, "late.md")), true, "the root note wasn't moved");
    assert.equal(fs.existsSync(path.join(repo, "Home", "late.md")), false);
    assert.equal(fs.readFileSync(tokenFile, "utf8"), token, "the running copy's stop token is untouched");

    // So `stop` still works.
    const stop = start(env, ["stop", "--port", String(PORT)]);
    await stop.exited;
    assert.match(stop.out(), /Stopping the notes server/);
    assert.equal(await Promise.race([a.exited, new Promise<string>((r) => setTimeout(() => r("still running"), 15_000))]), 0);
  } finally {
    if (a.child.exitCode === null) a.child.kill();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
