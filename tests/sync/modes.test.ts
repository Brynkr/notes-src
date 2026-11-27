// Home/Work modes: moving root notes into Home/ (NoteStore.moveIntoModes)
// while other machines still edit them at the old paths.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { NoteStore } from "../../server/notes.ts";
import { isEarlierVersion } from "../../server/sync.ts";
import { hasConflictMarkers, makeWorld, type Machine, type World } from "../helpers.ts";

let world: World;
beforeEach(async () => {
  world = await makeWorld();
});
afterEach(async () => {
  await world.cleanup();
});

/** What NotesRuntime does at startup (without its pull-first step, to test the worst case). */
const moveIntoModes = (m: Machine) =>
  new NoteStore({ root: m.dir, worktreeLock: m.lock, machineName: m.name }).moveIntoModes((rel, abs) => isEarlierVersion(m.git, rel, abs));
const norm = (fs: string[]) => fs.map((f) => f.replace(/\\/g, "/"));

async function pair(initial: Record<string, string>) {
  const A = world.machine("A");
  for (const [f, t] of Object.entries(initial)) A.write(f, t);
  assert.equal((await A.sync()).state, "synced");
  const B = world.machine("B");
  assert.equal((await B.sync()).state, "synced");
  return { A, B };
}

function assertConverged(A: Machine, B: Machine) {
  assert.deepEqual(norm(B.files()), norm(A.files()));
  for (const f of A.files()) {
    assert.equal(B.read(f), A.read(f), `content of ${f}`);
    assert.equal(hasConflictMarkers(A.read(f)), false, `markers in ${f}`);
  }
}

describe("Home/Work: moving root notes into Home/", () => {
  test("A moves its notes into Home/; B, not moved yet, edits one at the old path: the edit lands in Home/", async () => {
    const { A, B } = await pair({ "a.md": "# A\n\noriginal\n", "sub/b.md": "# B\n", "Work/w.md": "# W\n" });
    const moved = await moveIntoModes(A);
    assert.deepEqual(moved.sort(), [["a.md", "Home/a.md"], ["sub/b.md", "Home/sub/b.md"]]);
    assert.equal(A.exists("Work/w.md"), true, "Work notes stay where they are");
    assert.equal((await A.sync()).state, "synced");

    B.write("a.md", "# A\n\nedited on B\n");
    assert.equal((await B.sync()).state, "synced");
    // B's server moves its notes too when it starts with the new version.
    await moveIntoModes(B);
    assert.equal((await B.sync()).state, "synced");
    await A.sync();

    for (const m of [A, B]) {
      assert.equal(m.read("Home/a.md"), "# A\n\nedited on B\n", `${m.name}: edit kept in Home/`);
      assert.equal(m.exists("a.md"), false, `${m.name}: no copy left at the root`);
      assert.equal(m.read("Home/sub/b.md"), "# B\n");
    }
    assertConverged(A, B);
  });

  test("the other order: B edits at the old path and syncs first, then A (who moved) syncs", async () => {
    const { A, B } = await pair({ "a.md": "# A\n\noriginal\n" });
    B.write("a.md", "# A\n\nedited on B\n");
    assert.equal((await B.sync()).state, "synced");
    await moveIntoModes(A);
    assert.equal((await A.sync()).state, "synced");
    await B.sync();
    await moveIntoModes(B);
    await B.sync();
    await A.sync();
    for (const m of [A, B]) {
      assert.equal(m.read("Home/a.md"), "# A\n\nedited on B\n");
      assert.equal(m.exists("a.md"), false);
    }
    assertConverged(A, B);
  });

  test("both machines move independently before syncing: one copy each, no conflict copies", async () => {
    const { A, B } = await pair({ "a.md": "# A\n", "b.md": "# B\n" });
    await moveIntoModes(A);
    await moveIntoModes(B);
    assert.equal((await A.sync()).state, "synced");
    const st = await B.sync();
    assert.equal(st.state, "synced");
    assert.deepEqual(st.conflicts, []);
    await A.sync();
    assert.deepEqual(norm(A.files()), ["Home/a.md", "Home/b.md"]);
    assertConverged(A, B);
  });

  test("both machines edit the note around the move: the root copy becomes a conflict copy in Home/", async () => {
    const { A, B } = await pair({ "a.md": "# A\n\noriginal\n" });
    await moveIntoModes(A);
    A.write("Home/a.md", "# A\n\nedited on A after the move\n");
    await A.sync();
    B.write("a.md", "# A\n\nedited on B\n");
    await B.sync();
    await moveIntoModes(B);
    await B.sync();
    await A.sync();
    const files = norm(A.files());
    assert.equal(A.read("Home/a.md"), "# A\n\nedited on A after the move\n");
    const copy = files.find((f) => f.startsWith("Home/a (conflict "));
    assert.ok(copy, `conflict copy in ${files.join(", ")}`);
    assert.equal(A.read(copy), "# A\n\nedited on B\n");
    assert.equal(A.exists("a.md"), false);
    assertConverged(A, B);
  });

  test("history follows the move", async () => {
    const { A } = await pair({ "a.md": "# A\n\nfirst\n" });
    A.write("a.md", "# A\n\nsecond\n");
    await A.sync();
    await moveIntoModes(A);
    await A.sync();
    const log = (await A.git.run(["log", "--follow", "--format=%s", "--", "Home/a.md"])).stdout.trim().split("\n");
    assert.equal(log.length, 3, "the move plus both earlier versions");
  });
});

describe("IDE mode: code files sync like notes", () => {
  test("both machines edit the same lines of a code file: both kept, conflict copy keeps the extension, no markers", async () => {
    const { A, B } = await pair({ "Work/proj/main.py": "def f():\n    return 1\n" });
    A.write("Work/proj/main.py", "def f():\n    return 2  # A\n");
    B.write("Work/proj/main.py", "def f():\n    return 3  # B\n");
    await A.sync();
    const st = await B.sync();
    assert.equal(st.state, "conflict", "a conflict copy was made");
    assert.equal(st.conflicts.length, 1);
    await A.sync();
    const files = norm(A.files());
    const copy = files.find((f) => /^Work\/proj\/main \(conflict \d{4}-\d{2}-\d{2} A\)\.py$/.test(f));
    assert.ok(copy, files.join(", "));
    assert.equal(B.read("Work/proj/main.py"), "def f():\n    return 3  # B\n", "local version stays in place");
    assert.equal(B.read(copy), "def f():\n    return 2  # A\n");
    assertConverged(A, B);
  });
});
