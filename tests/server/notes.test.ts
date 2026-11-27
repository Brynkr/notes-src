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
    for (const bad of ["../x.md", "/etc/x.md", ".git/config", "a/../../x.md", "notes.txt", "a\\b.md", ".hidden.md", "C:/x.md", ""]) {
      assert.throws(() => resolveNotePath(dir, bad), `should reject ${JSON.stringify(bad)}`);
    }
    assert.equal(resolveNotePath(dir, "sub/a.md"), path.join(dir, "sub", "a.md"));
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
