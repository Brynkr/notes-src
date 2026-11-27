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
