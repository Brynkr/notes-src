import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Queue } from "../../server/git.ts";
import { extractTitle, noteFilename, NoteStore, parseTags, resolveNotePath, sha256, slugify, splitFrontMatter } from "../../server/notes.ts";
import { SearchIndex, toFtsQuery } from "../../server/search.ts";
import { NoteWatcher } from "../../server/watcher.ts";
import { MARK_END, MARK_START } from "../../shared/types.ts";
import { tempDir } from "../helpers.ts";
import { inMode, modeOf, pathInMode } from "../../shared/modes.ts";

let dir: string;
let store: NoteStore;
const fixed = new Date(2026, 10, 27, 9, 5, 7);

beforeEach(async () => {
  dir = await tempDir("notes-store-");
  store = new NoteStore({ root: dir, worktreeLock: new Queue(), machineName: "laptop", now: () => fixed });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("filenames and titles", () => {
  test("filename is YYYYMMDD-HHMMSS-slug.md in local time", () => {
    assert.equal(noteFilename("Git Notes: a plan!", fixed), "20261127-090507-git-notes-a-plan.md");
    assert.equal(noteFilename("", fixed), "20261127-090507-untitled.md");
    assert.equal(slugify("Café Ünïcode — ok"), "cafe-unicode-ok");
    assert.equal(slugify("日本語"), "untitled");
    assert.ok(slugify("x".repeat(200)).length <= 50);
  });

  test("title from first H1, then first line, then filename", () => {
    assert.equal(extractTitle("# Hello\n\nbody", "a.md"), "Hello");
    assert.equal(extractTitle("intro line\n\n# Later H1\n", "a.md"), "Later H1");
    assert.equal(extractTitle("## Sub\ntext\n", "a.md"), "Sub");
    assert.equal(extractTitle("---\ntitle: x\n---\n\n# Real\n", "a.md"), "Real");
    assert.equal(extractTitle("```\n# not a title\n```\nplain\n", "a.md"), "plain");
    assert.equal(extractTitle("\n\n", "20261127-090507-my-note.md"), "my note");
    assert.equal(extractTitle("# Closed ATX #\n", "a.md"), "Closed ATX");
    assert.equal(extractTitle("#hashtag not heading\n", "a.md"), "#hashtag not heading");
  });

  test("front matter tags in all three YAML forms", () => {
    assert.deepEqual(parseTags(splitFrontMatter("---\ntags: [a, \"b c\"]\n---\n").yaml), ["a", "b c"]);
    assert.deepEqual(parseTags(splitFrontMatter("---\ntags: a, b\n---\n").yaml), ["a", "b"]);
    assert.deepEqual(parseTags(splitFrontMatter("---\ncreated: 2026\ntags:\n  - x\n  - y\nother: 1\n---\nbody").yaml), ["x", "y"]);
    assert.deepEqual(parseTags(splitFrontMatter("no front matter").yaml), []);
  });

  test("path validation", () => {
    for (const bad of ["../x.md", "/etc/x.md", ".git/config", "a/../../x.md", "photo.png", "budget.xlsx", "Makefile", "a\\b.md", ".hidden.md", "C:/x.md", "../x.py", ""]) {
      assert.throws(() => resolveNotePath(dir, bad), `should reject ${JSON.stringify(bad)}`);
    }
    assert.equal(resolveNotePath(dir, "sub/a.md"), path.join(dir, "sub", "a.md"));
    // IDE mode: text and code files by extension.
    for (const ok of ["notes.txt", "Work/proj/main.py", "src/x.cpp", "lib/y.h", "app.ts", "run.ps1", "conf.toml"]) {
      assert.equal(resolveNotePath(dir, ok), path.join(dir, ...ok.split("/")));
    }
  });
});

describe("NoteStore", () => {
  test("create, list, read, delete", async () => {
    const n = await store.create("First note");
    assert.equal(n.path, "20261127-090507-first-note.md");
    assert.equal(n.text, "# First note\n\n");
    const n2 = await store.create("First note");
    assert.equal(n2.path, "20261127-090507-first-note-2.md");
    const list = await store.list();
    assert.deepEqual(list.map((m) => m.title).sort(), ["First note", "First note"]);
    assert.equal((await store.read(n.path)).hash, n.hash);
    await store.trash(n.path);
    assert.equal(fs.existsSync(path.join(dir, n.path)), false);
    await assert.rejects(store.read(n.path), /No such note/);
  });

  test("Trash: move, list, read, restore, purge, empty", async () => {
    const a = await store.create("Alpha");
    fs.mkdirSync(path.join(dir, "sub"));
    await store.write("sub/b.md", "# Beta\n", null);
    assert.equal(await store.trash(a.path), a.path);
    assert.equal(await store.trash("sub/b.md"), "sub/b.md");
    assert.deepEqual((await store.list()).map((m) => m.path), [], "trashed notes leave the list");
    const trash = await store.listTrash();
    assert.deepEqual(trash.map((t) => t.title).sort(), ["Alpha", "Beta"]);
    assert.equal((await store.readTrash("sub/b.md")).text, "# Beta\n");

    // Same name trashed twice keeps both.
    await store.write("sub/b.md", "# Beta two\n", null);
    assert.equal(await store.trash("sub/b.md"), "sub/b-2.md");

    // Restoring onto a path that's taken again gets a "(restored)" name.
    await store.write("sub/b.md", "# Beta three\n", null);
    assert.equal(await store.restore("sub/b.md"), "sub/b (restored).md");
    assert.equal(fs.readFileSync(path.join(dir, "sub", "b (restored).md"), "utf8"), "# Beta\n");
    assert.equal(await store.restore(a.path), a.path);
    assert.ok((await store.list()).some((m) => m.path === a.path));

    await store.purge("sub/b-2.md");
    assert.deepEqual(await store.listTrash(), []);
    assert.equal(fs.existsSync(path.join(dir, ".trash")), false, "empty trash folders are tidied up");
    await store.trash(a.path);
    assert.equal(await store.emptyTrash(), 1);
    await assert.rejects(store.restore(a.path), /Not in the Trash/);
    assert.throws(() => store.resolveTrash("../escape.md"));
  });

  test("trashing with a stale hash is refused", async () => {
    const { hash } = await store.write("x.md", "# X\n", null);
    await store.write("x.md", "# X edited\n", hash);
    await assert.rejects(store.trash("x.md", hash), /changed since/);
  });

  test("front matter round-trips byte for byte", async () => {
    const text = "---\ntags: [ a,b ]   \ncreated: 2026-11-25T22:10:00+13:00\nweird:   'spacing'\n---\n# T\n\nbody\n";
    const { hash } = await store.write("fm.md", text, null);
    const edited = text.replace("body", "body edited");
    await store.write("fm.md", edited, hash);
    assert.equal(fs.readFileSync(path.join(dir, "fm.md"), "utf8"), edited);
  });

  test("existing CRLF line endings are preserved", async () => {
    fs.writeFileSync(path.join(dir, "win.md"), "# Win\r\n\r\nline\r\n");
    const r = await store.read("win.md");
    // The editor sends \n; the file keeps \r\n.
    await store.write("win.md", r.text.replace(/\r\n/g, "\n") + "more\n", r.hash);
    assert.equal(fs.readFileSync(path.join(dir, "win.md"), "utf8"), "# Win\r\n\r\nline\r\nmore\r\n");
  });

  test("saving over a file that changed on disk keeps both versions", async () => {
    const { hash } = await store.write("n.md", "# N\n\noriginal\n", null);
    fs.writeFileSync(path.join(dir, "n.md"), "# N\n\nchanged by merge\n");
    const res = await store.write("n.md", "# N\n\nmy unsaved edit\n", hash);
    assert.equal(res.conflictCopy, "n (conflict 2026-11-27 laptop).md");
    assert.equal(fs.readFileSync(path.join(dir, "n.md"), "utf8"), "# N\n\nmy unsaved edit\n");
    assert.equal(fs.readFileSync(path.join(dir, res.conflictCopy!), "utf8"), "# N\n\nchanged by merge\n");
    const metas = await store.list();
    assert.equal(metas.find((m) => m.path === res.conflictCopy)?.conflict, true);
  });

  test("saving a note that was deleted underneath recreates it", async () => {
    const { hash } = await store.write("d.md", "# D\n", null);
    fs.rmSync(path.join(dir, "d.md"));
    const res = await store.write("d.md", "# D\n\nstill typing\n", hash);
    assert.equal(res.conflictCopy, undefined);
    assert.equal(fs.readFileSync(path.join(dir, "d.md"), "utf8"), "# D\n\nstill typing\n");
  });

  test("a scan triggered by list() still reports external deletes", async () => {
    await store.write("x.md", "# x\n", null);
    const deleted: string[] = [];
    store.on("deleted", (p) => deleted.push(...p));
    fs.rmSync(path.join(dir, "x.md"));
    await store.list();
    assert.deepEqual(deleted, ["x.md"]);
  });

  test("notes over 2 MB are refused", async () => {
    await assert.rejects(store.write("huge.md", "x".repeat(2 * 1024 * 1024 + 1), null), /limited to 2 MB/);
    assert.equal(fs.existsSync(path.join(dir, "huge.md")), false);
  });

  test("no temp files are left behind", async () => {
    for (let i = 0; i < 20; i++) await store.write("t.md", `# t ${i}\n`, i === 0 ? null : sha256(`# t ${i - 1}\n`));
    assert.deepEqual(fs.readdirSync(dir), ["t.md"]);
  });
});

describe("NoteWatcher", () => {
  test("reports external edits and deletes, ignores the app's own writes", async () => {
    await store.write("own.md", "# own\n", null);
    await store.scan();
    const watcher = new NoteWatcher(store, { debounceMs: 50, rescanMs: 0 });
    const changed: string[] = [];
    const deleted: string[] = [];
    watcher.on("changed", (p) => changed.push(...p));
    watcher.on("deleted", (p) => deleted.push(...p));
    watcher.start();
    try {
      await store.write("own.md", "# own 2\n", sha256("# own\n"));
      fs.mkdirSync(path.join(dir, "sub"));
      fs.writeFileSync(path.join(dir, "sub", "ext.md"), "# external\n");
      await new Promise((r) => setTimeout(r, 400));
      await watcher.idle();
      assert.deepEqual(changed, ["sub/ext.md"]);
      fs.rmSync(path.join(dir, "sub", "ext.md"));
      await new Promise((r) => setTimeout(r, 400));
      await watcher.idle();
      assert.deepEqual(deleted, ["sub/ext.md"]);
    } finally {
      watcher.stop();
    }
  });
});

describe("SearchIndex", () => {
  test("indexes, ranks titles, prefix-matches, updates and removes", () => {
    const idx = new SearchIndex(":memory:");
    idx.upsert("a.md", "h1", "# Garden plans\n\nTomatoes and basil this summer.\n");
    idx.upsert("b.md", "h2", "# Shopping\n\nBuy garden hose.\n");
    let hits = idx.search("garden");
    assert.deepEqual(hits.map((h) => h.path), ["a.md", "b.md"]);
    hits = idx.search("tomat");
    assert.equal(hits[0].path, "a.md");
    assert.ok(hits[0].snippet.includes(`${MARK_START}Tomatoes${MARK_END}`));
    idx.upsert("a.md", "h3", "# Garden plans\n\nNow potatoes.\n");
    assert.equal(idx.search("tomatoes").length, 0);
    idx.remove("b.md");
    assert.deepEqual(idx.search("hose"), []);
    assert.deepEqual(idx.search('"; DROP TABLE files; --'), []);
    idx.close();
  });

  test("toFtsQuery never passes FTS syntax through", () => {
    assert.equal(toFtsQuery("foo bar"), '"foo" "bar"*');
    assert.equal(toFtsQuery('a" OR NEAR(b'), '"a" "OR" "NEAR" "b"*');
    assert.equal(toFtsQuery("  ***  "), "");
  });

  test("a corrupt index file is thrown away and rebuilt", () => {
    const file = path.join(dir, "idx", "index.sqlite");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "this is not a database".repeat(100));
    const idx = new SearchIndex(file);
    idx.upsert("a.md", "h", "# hi\n");
    assert.equal(idx.search("hi").length, 1);
    idx.close();
  });
});

describe("Home/Work modes", () => {
  test("modeOf / pathInMode", () => {
    assert.equal(modeOf("Work/a.md"), "work");
    assert.equal(modeOf("work/sub/a.md"), "work");
    assert.equal(modeOf("Home/a.md"), "home");
    assert.equal(modeOf("a.md"), "home");
    assert.equal(modeOf("Workshop/a.md"), "home");
    assert.equal(modeOf("Work.md"), "home");
    assert.equal(pathInMode("Work/sub/a.md"), "sub/a.md");
    assert.equal(pathInMode("other/a.md"), "other/a.md");
  });

  test("create puts the note in the mode's folder", async () => {
    assert.equal((await store.create("Plan", "work")).path, "Work/20261127-090507-plan.md");
    assert.equal((await store.create("Plan", "home")).path, "Home/20261127-090507-plan.md");
    assert.equal((await store.create("Plan")).path, "20261127-090507-plan.md");
  });

  test("moveIntoModes moves root notes and folders into Home/, leaving Home/, Work/ and the Trash alone", async () => {
    await store.write("a.md", "# A\n", null);
    await store.write("sub/b.md", "# B\n", null);
    await store.write("Work/w.md", "# W\n", null);
    await store.write("Home/h.md", "# H\n", null);
    fs.mkdirSync(path.join(dir, ".trash"));
    fs.writeFileSync(path.join(dir, ".trash", "old.md"), "# Old\n");
    const moved = await store.moveIntoModes();
    assert.deepEqual(moved.sort(), [["a.md", "Home/a.md"], ["sub/b.md", "Home/sub/b.md"]]);
    assert.deepEqual((await store.list()).map((n) => n.path).sort(), ["Home/a.md", "Home/h.md", "Home/sub/b.md", "Work/w.md"]);
    assert.equal(fs.existsSync(path.join(dir, "sub")), false, "emptied folder removed");
    assert.equal(fs.existsSync(path.join(dir, ".trash", "old.md")), true);
    assert.deepEqual(await store.moveIntoModes(), [], "nothing left to move");
  });

  test("moveIntoModes: a same-content leftover is removed; different content becomes a conflict copy, or replaces an older Home copy", async () => {
    const put = (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    };
    put("Home/same.md", "# S\n");
    put("same.md", "# S\n");
    put("Home/diff.md", "# D\n\nin Home\n");
    put("diff.md", "# D\n\nat the root\n");
    put("Home/old.md", "# O\n\nolder\n");
    put("old.md", "# O\n\nnewer\n");
    const moved = await store.moveIntoModes(async (rel) => rel === "old.md");
    assert.equal(fs.existsSync(path.join(dir, "same.md")), false);
    assert.equal(fs.readFileSync(path.join(dir, "Home", "diff.md"), "utf8"), "# D\n\nin Home\n");
    assert.equal(fs.readFileSync(path.join(dir, "Home", "diff (conflict 2026-11-27 laptop).md"), "utf8"), "# D\n\nat the root\n");
    assert.equal(fs.readFileSync(path.join(dir, "Home", "old.md"), "utf8"), "# O\n\nnewer\n");
    assert.equal(fs.existsSync(path.join(dir, "old.md")), false);
    assert.equal(moved.length, 3);
  });

  test("search can be narrowed to one mode", () => {
    const idx = new SearchIndex(":memory:");
    idx.upsert("Home/a.md", "1", "# Garden\n\ntomatoes\n");
    idx.upsert("Work/b.md", "2", "# Garden project\n");
    idx.upsert("c.md", "3", "# Garden at the root\n");
    const only = (m: "home" | "work") => idx.search("garden", (p) => inMode(p, m)).map((h) => h.path).sort();
    assert.deepEqual(only("work"), ["Work/b.md"]);
    assert.deepEqual(only("home"), ["Home/a.md", "c.md"], "root notes count as Home");
    idx.close();
  });

  test("a lowercase work folder counts as Work", async () => {
    await store.write("work/w.md", "# W\n", null);
    assert.deepEqual(await store.moveIntoModes(), []);
  });

  test("reads and saves at a moved note's old path go to Home/, never recreating it at the root", async () => {
    const n = await store.write("a.md", "# A\n", null);
    await store.moveIntoModes();
    const r = await store.read("a.md");
    assert.equal(r.path, "Home/a.md");
    assert.equal(r.hash, n.hash);
    const saved = await store.write("a.md", "# A\n\nfrom an old tab\n", n.hash);
    assert.equal(saved.path, "Home/a.md");
    assert.equal(saved.conflictCopy, undefined, "baseHash still matches after the move");
    assert.equal(fs.existsSync(path.join(dir, "a.md")), false);
    assert.equal(fs.readFileSync(path.join(dir, "Home", "a.md"), "utf8"), "# A\n\nfrom an old tab\n");
    // A genuinely new root note is written where asked.
    assert.equal((await store.write("new.md", "# N\n", null)).path, undefined);
  });
});

describe("IDE mode: text and code files", () => {
  test("files() lists code files, list() only notes; titles are filenames; caches and big files skipped", async () => {
    await store.write("Work/proj/main.py", "import os\n", null);
    await store.write("Work/note.md", "# Note\n", null);
    fs.mkdirSync(path.join(dir, "Work", "proj", "node_modules", "x"), { recursive: true });
    fs.writeFileSync(path.join(dir, "Work", "proj", "node_modules", "x", "index.js"), "x");
    fs.writeFileSync(path.join(dir, "Work", "proj", "data.csv"), "a,".repeat(1_100_000)); // 2.2 MB
    fs.writeFileSync(path.join(dir, "Work", "proj", "logo.png"), "png");
    const files = await store.files();
    assert.deepEqual(files.map((f) => f.path), ["Work/note.md", "Work/proj/main.py"]);
    assert.equal(files.find((f) => f.path.endsWith(".py"))!.title, "main.py");
    assert.deepEqual(files.find((f) => f.path.endsWith(".py"))!.tags, []);
    assert.deepEqual((await store.list()).map((n) => n.path), ["Work/note.md"]);
  });

  test("createFile makes an empty file and refuses an existing one or a binary type", async () => {
    const f = await store.createFile("Work/src/app.ts");
    assert.equal(f.text, "");
    assert.equal(fs.readFileSync(path.join(dir, "Work", "src", "app.ts"), "utf8"), "");
    await assert.rejects(store.createFile("Work/src/app.ts"), /already exists/);
    await assert.rejects(store.createFile("Work/a.png"), /Only notes and text or code files/);
  });

  test("code files get conflict copies with their own extension, and stay out of Home/ moves", async () => {
    const f = await store.write("tool.py", "print(1)\n", null);
    fs.writeFileSync(path.join(dir, "tool.py"), "print(2)\n"); // changed underneath
    const r = await store.write("tool.py", "print(3)\n", f.hash);
    assert.equal(r.conflictCopy, "tool (conflict 2026-11-27 laptop).py");
    assert.deepEqual(await store.moveIntoModes(), [], "code files are not moved into Home/");
  });
});

describe("images in notes", () => {
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  test("saveImage stores beside the note's mode folder and returns Markdown relative to the note", async () => {
    const a = await store.saveImage("Work/proj/20261128-090000-plan.md", png, "image/webp");
    assert.match(a.path, /^Work\/images\/20261127-090507-[0-9a-f]{6}\.webp$/);
    assert.equal(a.markdown, `![](../images/${a.path.slice("Work/images/".length)})`);
    assert.deepEqual(fs.readFileSync(path.join(dir, ...a.path.split("/"))), png);
    const b = await store.saveImage("Home/20261128-090000-x.md", png, "image/png");
    assert.match(b.markdown, /^!\[\]\(images\/20261127-090507-[0-9a-f]{6}\.png\)$/);
    const root = await store.saveImage("old.md", png, "image/jpeg");
    assert.match(root.path, /^Home\/images\/.*\.jpg$/, "notes outside a mode folder: Home/");
    const back = await store.readImage(a.path);
    assert.equal(back.mime, "image/webp");
    assert.deepEqual(back.bytes, png);
  });

  test("refuses other types, empty and oversized images, bad note paths and path tricks", async () => {
    await assert.rejects(store.saveImage("Home/a.md", png, "image/svg+xml"), /WebP, PNG, JPEG or GIF/);
    await assert.rejects(store.saveImage("Home/a.md", Buffer.alloc(0), "image/png"), /Empty/);
    await assert.rejects(store.saveImage("Home/a.md", Buffer.alloc(5 * 1024 * 1024 + 1), "image/png"), /limited to 5 MB/);
    await assert.rejects(store.saveImage("../a.md", png, "image/png"), /Invalid/);
    await assert.rejects(store.readImage("../secret.png"), /Invalid/);
    await assert.rejects(store.readImage("Home/notes.md"), /Not an image/);
    await assert.rejects(store.readImage("Home/images/missing.webp"), /No such image/);
  });

  test("images aren't listed as notes or files", async () => {
    await store.saveImage("Home/a.md", png, "image/webp");
    assert.deepEqual(await store.files(), []);
  });
});

describe("listing with a live watcher", () => {
  test("list() uses what the store knows instead of re-walking; writes still show up", async () => {
    const w = new NoteWatcher(store, { rescanMs: 0 });
    w.start();
    try {
      assert.equal(store.watched, true);
      await store.write("Home/a.md", "# A\n", null);
      assert.deepEqual((await store.list()).map((n) => n.path), ["Home/a.md"], "own writes are known at once");
      // An outside change arrives through the watcher, not a re-walk on every list().
      fs.mkdirSync(path.join(dir, "Home"), { recursive: true });
      fs.writeFileSync(path.join(dir, "Home", "b.md"), "# B\n");
      const t0 = Date.now();
      while (!(await store.list()).some((n) => n.path === "Home/b.md")) {
        if (Date.now() - t0 > 10_000) throw new Error("watcher never reported the new note");
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      w.stop();
    }
    assert.equal(store.watched, false);
  });

  test("code files are listed without being read (size+mtime stand in for the hash until opened)", async () => {
    fs.mkdirSync(path.join(dir, "Work"), { recursive: true });
    fs.writeFileSync(path.join(dir, "Work", "x.py"), "print(1)\n");
    const f = (await store.files()).find((x) => x.path === "Work/x.py")!;
    assert.match(f.hash, /^m:9:\d+$/);
    const r = await store.read("Work/x.py");
    assert.equal(r.hash, sha256("print(1)\n"));
    // Saving with the real hash works (no false conflict).
    const saved = await store.write("Work/x.py", "print(2)\n", r.hash);
    assert.equal(saved.conflictCopy, undefined);
  });
});
