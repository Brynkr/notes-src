import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaults } from "../../server/config.ts";
import { NotesRuntime } from "../../server/runtime.ts";
import { tempDir } from "../helpers.ts";

process.env.NOTES_APP_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "notes-data-"));

test("history lists sync commits for a note, follows the Trash, and returns old versions", async () => {
  const repoPath = await tempDir("notes-hist-");
  const rt = await NotesRuntime.start({ ...defaults(), repoPath, sync: false, machineName: "desk" });
  try {
    assert.deepEqual(await rt.history("a.md").catch(() => []), [], "no commits yet");
    const { hash } = await rt.store.write("a.md", "# A\n\nv1\n", null);
    await rt.engine.request();
    await rt.store.write("a.md", "# A\n\nv2\n", hash);
    await rt.engine.request();
    // Trash and restore: history keeps following it.
    const t = await rt.store.trash("a.md");
    await rt.engine.request();
    await rt.store.restore(t);
    await rt.engine.request();

    const h = await rt.history("a.md");
    assert.ok(h.length >= 2);
    assert.equal(h.at(-1)!.machine, "desk");
    const texts = await Promise.all(h.map((e) => rt.version(e.commit, e.file)));
    assert.ok(texts.includes("# A\n\nv1\n"));
    assert.ok(texts.includes("# A\n\nv2\n"));
    await assert.rejects(rt.version("not-a-commit", "a.md"), /Bad commit/);
    await assert.rejects(rt.version(h[0].commit, "../../etc/passwd"), /Bad path/);
    assert.throws(() => (rt as unknown as { repoRel: (p: string) => string }).repoRel("../x.md"));
  } finally {
    await rt.stop(0);
  }
});

test("IDE mode: uncommitted changes, recent commits with files, and a file's text at a commit", async () => {
  const repoPath = await tempDir("notes-ide-");
  const rt = await NotesRuntime.start({ ...defaults(), repoPath, sync: false, machineName: "desk" });
  try {
    assert.deepEqual(await rt.commits(null), [], "no commits yet");
    const py = await rt.store.write("Work/proj/main.py", "print(1)\n", null);
    await rt.store.write("Home/a.md", "# A\n", null);
    const before = await rt.changes(null);
    assert.deepEqual(before, [
      { path: "Home/a.md", status: "A" },
      { path: "Work/proj/main.py", status: "A" },
    ]);
    assert.deepEqual(await rt.changes("work"), [{ path: "Work/proj/main.py", status: "A" }]);
    await rt.engine.request(); // commits (no remote)
    assert.deepEqual(await rt.changes(null), [], "committed");

    await rt.store.write("Work/proj/main.py", "print(2)\n", py.hash);
    assert.deepEqual(await rt.changes(null), [{ path: "Work/proj/main.py", status: "M" }]);
    await rt.engine.request();

    const work = await rt.commits("work");
    assert.equal(work.length, 2);
    assert.deepEqual(work[0].files, [{ path: "Work/proj/main.py", status: "M" }]);
    assert.equal(work[0].machine, "desk");
    assert.ok(work[0].parent, "has a parent to diff against");
    assert.deepEqual(work[1].files, [{ path: "Work/proj/main.py", status: "A" }], "Home files filtered out");
    assert.equal(await rt.fileAt(work[0].parent!, "Work/proj/main.py"), "print(1)\n");
    assert.equal(await rt.fileAt(work[0].commit, "Work/proj/main.py"), "print(2)\n");
    assert.equal(await rt.fileAt("HEAD", "Work/proj/main.py"), "print(2)\n");
    assert.equal(await rt.fileAt(work[1].commit, "Work/nope.py"), null);
    await assert.rejects(rt.fileAt("HEAD~1", "Work/proj/main.py"), /Bad commit/);
    assert.throws(() => rt.store.resolve("../x.py"));
    await assert.rejects(rt.fileAt("HEAD", "../outside.py"));

    const home = await rt.commits("home");
    assert.equal(home.length, 1);
    assert.deepEqual(home[0].files, [{ path: "Home/a.md", status: "A" }]);
    // Code files are never in the search index or the note list.
    assert.deepEqual((await rt.store.list()).map((n) => n.path), ["Home/a.md"]);
    assert.deepEqual(rt.search.search("print"), []);
  } finally {
    await rt.stop(0);
  }
});
