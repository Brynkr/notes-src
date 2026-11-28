// Git for IDE outside folders, against real repos in a temp folder (never a
// real project). Pull must never merge; push must never force.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { ProjectGit } from "../../server/projectgit.ts";
import { sh, tempDir } from "../helpers.ts";

let root: string;
let remote: string;
let a: string;
let b: string;
const write = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

beforeEach(async () => {
  root = await tempDir("notes-pgit-");
  remote = path.join(root, "remote.git");
  sh(root, "init", "-q", "--bare", "-b", "main", remote);
  a = path.join(root, "a");
  sh(root, "init", "-q", "-b", "main", a);
  sh(a, "remote", "add", "origin", remote);
  write(a, "app/main.py", "print(1)\n");
  write(a, "README.md", "# Project\n");
  sh(a, "add", "-A");
  sh(a, "commit", "-q", "-m", "first");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

test("not a repository: create() returns null", async () => {
  const plain = path.join(root, "plain");
  fs.mkdirSync(plain);
  assert.equal(await ProjectGit.create(plain), null);
});

test("status, commit chosen files only, push (sets upstream), file at HEAD", async () => {
  const g = (await ProjectGit.create(a))!;
  let s = await g.status();
  assert.equal(s.branch, "main");
  assert.equal(s.upstream, null);
  assert.deepEqual(s.changes, []);

  write(a, "app/main.py", "print(2)\n");
  write(a, "app/new.py", "x = 1\n");
  write(a, "notes.txt", "keep me uncommitted\n");
  write(a, "logo.png", "binary-ish");
  s = await g.status();
  assert.deepEqual(s.changes, [
    { path: "app/main.py", status: "M" },
    { path: "app/new.py", status: "A" },
    { path: "notes.txt", status: "A" },
  ], "text/code files only");
  assert.equal(await g.fileAtHead("app/main.py"), "print(1)\n");
  assert.equal(await g.fileAtHead("app/new.py"), null);

  await assert.rejects(g.commit("  ", ["app/main.py"]), /commit message/);
  await assert.rejects(g.commit("msg", []), /Tick at least one/);
  await assert.rejects(g.commit("msg", ["README.md"]), /no changes/);
  const hash = await g.commit("Update main, add new", ["app/main.py", "app/new.py"]);
  assert.match(hash, /^[0-9a-f]{7,}$/);
  assert.equal(sh(a, "log", "-1", "--format=%s").trim(), "Update main, add new");
  assert.deepEqual(sh(a, "show", "--name-only", "--format=", "HEAD").trim().split("\n").sort(), ["app/main.py", "app/new.py"]);
  assert.deepEqual((await g.status()).changes, [{ path: "notes.txt", status: "A" }], "unticked file left alone");

  assert.equal(await g.push(), "Pushed.");
  s = await g.status();
  assert.equal(s.upstream, "origin/main");
  assert.equal(s.ahead, 0);
  assert.equal(sh(remote, "log", "-1", "--format=%s", "main").trim(), "Update main, add new");
});

test("a folder inside a bigger repository: paths are relative to the folder", async () => {
  const g = (await ProjectGit.create(path.join(a, "app")))!;
  write(a, "app/main.py", "print(3)\n");
  write(a, "README.md", "# Changed outside the folder\n");
  assert.deepEqual((await g.status()).changes, [{ path: "main.py", status: "M" }]);
  await g.commit("only app", ["main.py"]);
  assert.deepEqual(sh(a, "show", "--name-only", "--format=", "HEAD").trim().split("\n"), ["app/main.py"]);
  assert.equal(await g.fileAtHead("main.py"), "print(3)\n");
});

test("pull fast-forwards; a diverged branch is refused and nothing is merged", async () => {
  const g = (await ProjectGit.create(a))!;
  await g.push();
  b = path.join(root, "b");
  sh(root, "clone", "-q", remote, b);
  write(b, "app/main.py", "print('from b')\n");
  sh(b, "commit", "-qam", "from b");
  sh(b, "push", "-q");

  assert.equal(await g.pull(), "Pulled.");
  assert.equal(fs.readFileSync(path.join(a, "app/main.py"), "utf8"), "print('from b')\n");
  assert.equal(await g.pull(), "Already up to date.");

  // Both sides commit: pulling must not merge.
  write(b, "README.md", "# from b\n");
  sh(b, "commit", "-qam", "b again");
  sh(b, "push", "-q");
  write(a, "app/other.py", "y = 2\n");
  await g.commit("a again", ["app/other.py"]);
  const head = sh(a, "rev-parse", "HEAD").trim();
  await assert.rejects(g.pull(), /can't simply fast-forward/);
  assert.equal(sh(a, "rev-parse", "HEAD").trim(), head, "HEAD unchanged");
  assert.equal(fs.existsSync(path.join(a, ".git", "MERGE_HEAD")), false, "not mid-merge");
  await assert.rejects(g.push(), /Pull first/, "push is refused, never forced");
});
