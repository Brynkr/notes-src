import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { folderId, OutsideFolders, parseOutsidePath } from "../../server/folders.ts";
import { Queue } from "../../server/git.ts";
import { NoteStore } from "../../server/notes.ts";
import type { ServerEvent } from "../../shared/types.ts";
import { tempDir } from "../helpers.ts";

let dir: string;
beforeEach(async () => {
  dir = await tempDir("notes-folders-");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

describe("IDE folders in the notes repo", () => {
  test("createFolder makes the folder with a .gitkeep (so it syncs); folders() lists empty ones too", async () => {
    const store = new NoteStore({ root: dir, worktreeLock: new Queue(), machineName: "t" });
    assert.equal(await store.createFolder("Work/sensor/drivers"), "Work/sensor/drivers");
    assert.equal(fs.existsSync(path.join(dir, "Work", "sensor", "drivers", ".gitkeep")), true);
    fs.mkdirSync(path.join(dir, "Work", "node_modules"));
    assert.deepEqual(await store.folders(), ["Work", "Work/sensor", "Work/sensor/drivers"]);
    await assert.rejects(store.createFolder("Work/sensor"), /already exists/);
    for (const bad of ["../out", "Work/../../x", ".hidden", "Work/.git", ""]) await assert.rejects(store.createFolder(bad), Error, bad);
    assert.deepEqual(await store.files(), [], "the .gitkeep isn't a file the app shows");
  });
});

describe("outside folders", () => {
  const make = (notesRoot: string | null = null) => {
    const events: ServerEvent[] = [];
    const saved: string[][] = [];
    const o = new OutsideFolders({ machineName: "t", notesRoot: () => notesRoot, onEvent: (e) => void events.push(e), onChange: (p) => void saved.push(p) });
    return { o, events, saved };
  };

  test("paths: @<id>/<rel>, ids are stable per folder", () => {
    assert.deepEqual(parseOutsidePath("@ab12cd34/src/main.py"), { id: "ab12cd34", rel: "src/main.py" });
    assert.equal(parseOutsidePath("Work/x.py"), null);
    assert.equal(parseOutsidePath("@nothex!/x.py"), null);
    assert.equal(folderId(dir), folderId(dir + path.sep));
    assert.match(folderId(dir), /^[0-9a-f]{8}$/);
  });

  test("add, read and save files, see outside changes, remove; the list is saved", async () => {
    const proj = path.join(dir, "proj");
    fs.mkdirSync(path.join(proj, "src"), { recursive: true });
    fs.writeFileSync(path.join(proj, "src", "main.py"), "print(1)\n");
    fs.writeFileSync(path.join(proj, "photo.png"), "x");
    const { o, events, saved } = make();
    try {
      const f = o.add(proj);
      assert.equal(f.name, "proj");
      assert.deepEqual(saved, [[proj]]);
      const store = o.store(f.id);
      assert.deepEqual((await store.files()).map((x) => x.path), ["src/main.py"], "only text/code files");
      const r = await store.read("src/main.py");
      await store.write("src/main.py", "print(2)\n", r.hash);
      assert.equal(fs.readFileSync(path.join(proj, "src", "main.py"), "utf8"), "print(2)\n");
      // Edited elsewhere (another editor): the change is reported as @id/... for open panes.
      fs.writeFileSync(path.join(proj, "src", "main.py"), "print(3)\n");
      await store.scan();
      assert.ok(events.some((e) => e.type === "note-changed" && e.path === `@${f.id}/src/main.py`), JSON.stringify(events));
      // Not a notes folder: no moving root .md files into Home/.
      fs.writeFileSync(path.join(proj, "README.md"), "# Readme\n");
      fs.mkdirSync(path.join(proj, "Home"));
      fs.writeFileSync(path.join(proj, "Home", "README.md"), "# Other\n");
      assert.equal((await store.read("README.md")).text, "# Readme\n");
      o.remove(f.id);
      assert.deepEqual(saved.at(-1), []);
      assert.throws(() => o.store(f.id), /isn't open/);
      assert.equal(fs.existsSync(path.join(proj, "src", "main.py")), true, "removing only forgets it");
    } finally {
      o.stopAll();
    }
  });

  test("refuses: relative paths, files, missing folders, drives, the home folder, the notes folder, duplicates", () => {
    const notes = path.join(dir, "notes");
    fs.mkdirSync(path.join(notes, "Home"), { recursive: true });
    fs.writeFileSync(path.join(dir, "file.txt"), "x");
    const proj = path.join(dir, "proj");
    fs.mkdirSync(proj);
    const { o } = make(notes);
    try {
      assert.throws(() => o.add("relative/path"), /full path/);
      assert.throws(() => o.add(path.join(dir, "file.txt")), /is a file/);
      assert.throws(() => o.add(path.join(dir, "missing")), /no folder/);
      assert.throws(() => o.add(path.parse(dir).root), /whole drive/);
      assert.throws(() => o.add(os.homedir()), /home folder/);
      assert.throws(() => o.add(notes), /notes folder/);
      assert.throws(() => o.add(path.join(notes, "Home")), /notes folder/);
      assert.throws(() => o.add(dir), /notes folder/, "a folder containing the notes folder");
      o.add(proj);
      assert.throws(() => o.add(proj), /already open/);
    } finally {
      o.stopAll();
    }
  });

  test("open() at startup skips folders that have gone missing", () => {
    const proj = path.join(dir, "proj");
    fs.mkdirSync(proj);
    const { o } = make();
    try {
      o.open([path.join(dir, "unplugged"), proj]);
      assert.deepEqual(o.list().map((f) => f.path), [proj]);
    } finally {
      o.stopAll();
    }
  });
});
