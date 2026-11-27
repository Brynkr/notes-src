import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { NotesRuntime } from "../../server/runtime.ts";
import { defaults } from "../../server/config.ts";
import { getRemoteUrl, nonNoteFiles, setRemoteUrl, setupRepo, testRemote, validateHosts, validateNotesDir, validateRemoteUrl } from "../../server/settings.ts";
import { sh, tempDir } from "../helpers.ts";

process.env.NOTES_APP_DATA_DIR ??= fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "notes-data-"));

describe("validation", () => {
  test("remote URLs", () => {
    for (const ok of ["https://github.com/you/notes.git", "git@github.com:you/notes.git", "ssh://git@host:22/x.git", "/srv/git/notes.git", "file:///srv/notes.git"]) {
      assert.equal(validateRemoteUrl(ok), ok);
    }
    for (const bad of ["", "--upload-pack=touch /tmp/x", "ext::sh -c touch% /tmp/pwned", "http://insecure/x.git", "notes.git", "https://a b/c"]) {
      assert.throws(() => validateRemoteUrl(bad), `should reject ${bad}`);
    }
  });

  test("notes dir and hosts", () => {
    assert.equal(validateNotesDir(""), ".");
    assert.equal(validateNotesDir("notes/"), "notes/");
    assert.throws(() => validateNotesDir("../x"));
    assert.throws(() => validateNotesDir(".git"));
    assert.deepEqual(validateHosts("pi.tail1234.ts.net, PI.tail1234.ts.net"), ["pi.tail1234.ts.net"]);
    assert.throws(() => validateHosts(["bad host"]));
  });

  test("nonNoteFiles", async () => {
    const d = await tempDir("notes-nn-");
    fs.writeFileSync(path.join(d, "a.md"), "");
    fs.mkdirSync(path.join(d, "sub"));
    fs.writeFileSync(path.join(d, "sub", "b.txt"), "");
    fs.writeFileSync(path.join(d, ".DS_Store"), "");
    assert.deepEqual(nonNoteFiles(d), []);
    fs.writeFileSync(path.join(d, "sub", "tax-return.pdf"), "");
    assert.deepEqual(nonNoteFiles(d), ["sub/tax-return.pdf"]);
  });
});

describe("setupRepo", () => {
  test("fresh start: clones an empty remote and the first sync pushes to it", async () => {
    const root = await tempDir("notes-setup-");
    const remote = path.join(root, "remote.git");
    sh(root, "init", "-q", "--bare", "-b", "main", remote);
    assert.equal((await testRemote(remote, false)).empty, true);
    const repoPath = path.join(root, "Notes");
    const msg = await setupRepo({ repoPath, remoteUrl: remote, remote: "origin", branch: "main", interactive: false });
    assert.match(msg, /Cloned/);
    assert.equal(await getRemoteUrl(repoPath, "origin"), remote);
    const rt = await NotesRuntime.start({ ...defaults(), repoPath, sync: false, machineName: "desk" });
    try {
      await rt.store.create("First note");
      const st = await rt.engine.request();
      assert.equal(st.state, "synced");
      assert.match(sh(remote, "ls-tree", "--name-only", "main"), /first-note\.md/);
    } finally {
      await rt.stop(0);
    }
  });

  test("clones an existing remote with notes", async () => {
    const root = await tempDir("notes-setup-");
    const remote = path.join(root, "remote.git");
    sh(root, "init", "-q", "--bare", "-b", "main", remote);
    const seed = path.join(root, "seed");
    sh(root, "clone", "-q", remote, seed);
    fs.writeFileSync(path.join(seed, "x.md"), "# X\n");
    sh(seed, "add", "-A");
    sh(seed, "commit", "-qm", "seed");
    sh(seed, "push", "-q", "origin", "main");
    const repoPath = path.join(root, "Notes");
    await setupRepo({ repoPath, remoteUrl: remote, remote: "origin", branch: "main", interactive: false });
    assert.equal(fs.readFileSync(path.join(repoPath, "x.md"), "utf8"), "# X\n");
  });

  test("adopts a folder of notes, refuses a folder of other files", async () => {
    const root = await tempDir("notes-setup-");
    const notes = path.join(root, "notes");
    fs.mkdirSync(notes);
    fs.writeFileSync(path.join(notes, "old.md"), "# Old\n");
    assert.match(await setupRepo({ repoPath: notes, remoteUrl: null, remote: "origin", branch: "main", interactive: false }), /Created/);
    assert.ok(fs.existsSync(path.join(notes, ".git")));

    const docs = path.join(root, "Documents");
    fs.mkdirSync(docs);
    fs.writeFileSync(path.join(docs, "passport.jpg"), "");
    await assert.rejects(setupRepo({ repoPath: docs, remoteUrl: null, remote: "origin", branch: "main", interactive: false }), /other files/);
    assert.equal(fs.existsSync(path.join(docs, ".git")), false);
  });

  test("unreachable or missing remotes get a plain-language message", async () => {
    const r = await testRemote("/nonexistent/repo.git", false);
    assert.equal(r.ok, false);
    assert.match(r.message, /No repository at that address/);
  });

  test("setRemoteUrl adds, changes and removes", async () => {
    const root = await tempDir("notes-remote-");
    sh(root, "init", "-q", "-b", "main");
    await setRemoteUrl(root, "origin", "git@github.com:a/b.git");
    assert.equal(await getRemoteUrl(root, "origin"), "git@github.com:a/b.git");
    await setRemoteUrl(root, "origin", "https://github.com/a/c.git");
    assert.equal(await getRemoteUrl(root, "origin"), "https://github.com/a/c.git");
    await setRemoteUrl(root, "origin", null);
    assert.equal(await getRemoteUrl(root, "origin"), null);
  });
});
