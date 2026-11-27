// HANDOVER section 13: sync scenarios against real git in temp repos.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { classifyGitError } from "../../server/git.ts";
import { isConflictCopy } from "../../server/sync.ts";
import { hasConflictMarkers, makeWorld, sh, type World } from "../helpers.ts";

let world: World;
beforeEach(async () => {
  world = await makeWorld();
});
afterEach(async () => {
  await world.cleanup();
});

/** Two machines with a shared starting note, both synced. */
async function pair(initial: Record<string, string> = { "a.md": "# A\n\nline 1\nline 2\nline 3\n" }) {
  const A = world.machine("A");
  for (const [f, t] of Object.entries(initial)) A.write(f, t);
  assert.equal((await A.sync()).state, "synced");
  const B = world.machine("B");
  assert.equal((await B.sync()).state, "synced");
  return { A, B };
}

function assertConverged(...ms: { files(): string[]; read(f: string): string }[]) {
  const [first, ...rest] = ms;
  for (const m of rest) {
    assert.deepEqual(m.files(), first.files());
    for (const f of first.files()) assert.equal(m.read(f), first.read(f), `content of ${f}`);
  }
}

function assertNoMarkers(m: { files(): string[]; read(f: string): string }) {
  for (const f of m.files()) assert.equal(hasConflictMarkers(m.read(f)), false, `markers in ${f}`);
}

describe("sync scenarios (HANDOVER 13)", () => {
  test("first sync into an empty remote pushes and sets upstream", async () => {
    const A = world.machine("A");
    A.write("hello.md", "# Hello\n");
    const st = await A.sync();
    assert.equal(st.state, "synced");
    assert.equal(sh(world.remote, "log", "--format=%s", "-1").trim().startsWith("auto: "), true);
    assert.equal(sh(A.dir, "rev-parse", "--abbrev-ref", "main@{upstream}").trim(), "origin/main");
  });

  test("1. A edits and syncs, then B syncs and sees the change", async () => {
    const { A, B } = await pair();
    A.write("a.md", "# A\n\nedited on A\n");
    assert.equal((await A.sync()).state, "synced");
    assert.equal((await B.sync()).state, "synced");
    assert.equal(B.read("a.md"), "# A\n\nedited on A\n");
  });

  test("2. A and B edit different notes offline, both changes survive", async () => {
    const { A, B } = await pair({ "a.md": "# A\n", "b.md": "# B\n" });
    A.write("a.md", "# A\n\nfrom A\n");
    B.write("b.md", "# B\n\nfrom B\n");
    await A.sync();
    assert.equal((await B.sync()).state, "synced");
    await A.sync();
    assert.equal(A.read("b.md"), "# B\n\nfrom B\n");
    assert.equal(B.read("a.md"), "# A\n\nfrom A\n");
    assertConverged(A, B);
  });

  test("3. A and B edit different parts of the same note, git merges cleanly", async () => {
    const base = "# Note\n\n" + Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const { A, B } = await pair({ "n.md": base });
    A.write("n.md", base.replace("line 2\n", "line 2 (A)\n"));
    B.write("n.md", base.replace("line 11\n", "line 11 (B)\n"));
    await A.sync();
    const st = await B.sync();
    assert.equal(st.state, "synced");
    assert.deepEqual(st.conflicts, []);
    await A.sync();
    assert.match(A.read("n.md"), /line 2 \(A\)[\s\S]*line 11 \(B\)/);
    assertConverged(A, B);
    assertNoMarkers(A);
  });

  test("4. same lines edited on both: both versions kept, conflict copy, no markers", async () => {
    const { A, B } = await pair();
    A.write("a.md", "# A\n\nline 1 from A\nline 2\nline 3\n");
    B.write("a.md", "# A\n\nline 1 from B\nline 2\nline 3\n");
    await A.sync();
    const st = await B.sync();
    assert.equal(st.state, "conflict");
    assert.equal(st.conflicts.length, 1);
    const copy = st.conflicts[0];
    assert.match(copy, /^a \(conflict \d{4}-\d{2}-\d{2} A\)\.md$/);
    // B (local) keeps its own text in place; A's version is in the copy.
    assert.equal(B.read("a.md"), "# A\n\nline 1 from B\nline 2\nline 3\n");
    assert.equal(B.read(copy), "# A\n\nline 1 from A\nline 2\nline 3\n");
    assertNoMarkers(B);
    const stA = await A.sync();
    assert.equal(stA.state, "conflict");
    assertConverged(A, B);
    // The repo is left clean, not mid-merge.
    assert.equal(sh(B.dir, "status", "--porcelain").trim(), "");
  });

  test("5. A deletes a note while B edits it: the edited note is kept", async () => {
    const { A, B } = await pair({ "a.md": "# A\n", "keep.md": "# K\n" });
    A.rm("a.md");
    B.write("a.md", "# A\n\nB was here\n");
    await A.sync();
    assert.equal((await B.sync()).state, "synced");
    assert.equal(B.read("a.md"), "# A\n\nB was here\n");
    await A.sync();
    assert.equal(A.read("a.md"), "# A\n\nB was here\n");
    assertConverged(A, B);

    // And the other order: B edits and syncs first, then A (who deleted) syncs.
    B.write("a.md", "# A\n\nedited again\n");
    A.rm("a.md");
    await B.sync();
    assert.equal((await A.sync()).state, "synced");
    assert.equal(A.read("a.md"), "# A\n\nedited again\n");
    await B.sync();
    assertConverged(A, B);
  });

  test("6. A and B create different notes at the same moment: both survive", async () => {
    const { A, B } = await pair({ "x.md": "# x\n" });
    A.write("20261127-120000-from-a.md", "# From A\n");
    B.write("20261127-120000-from-b.md", "# From B\n");
    const both = await Promise.all([A.sync(), B.sync()]);
    assert.deepEqual(both.map((s) => s.state), ["synced", "synced"]);
    await A.sync();
    await B.sync();
    assert.equal(A.exists("20261127-120000-from-b.md"), true);
    assert.equal(B.exists("20261127-120000-from-a.md"), true);
    assertConverged(A, B);
  });

  test("6b. both create a note with the same name: local kept, remote saved as a copy", async () => {
    const { A, B } = await pair({ "x.md": "# x\n" });
    A.write("same.md", "# Same\n\nfrom A\n");
    B.write("same.md", "# Same\n\nfrom B\n");
    await A.sync();
    const st = await B.sync();
    assert.equal(st.state, "conflict");
    assert.equal(B.read("same.md"), "# Same\n\nfrom B\n");
    assert.equal(B.read(st.conflicts[0]), "# Same\n\nfrom A\n");
    assertNoMarkers(B);
  });

  test("7. push rejected because the remote moved between fetch and push: retry succeeds", async () => {
    const { A } = await pair({ "a.md": "# A\n", "b.md": "# B\n" });
    // B is built with a hook that lets A push just before B's first push attempt.
    let moved = false;
    const B2 = world.machine("B", {
      beforePush: async (attempt) => {
        if (attempt === 1 && !moved) {
          moved = true;
          A.write("a.md", "# A\n\nsneaky\n");
          await A.sync();
        }
      },
    });
    B2.write("b.md", "# B\n\nfrom B\n");
    const st = await B2.sync();
    assert.equal(moved, true);
    assert.equal(st.state, "synced");
    assert.equal(B2.read("a.md"), "# A\n\nsneaky\n");
    await A.sync();
    assertConverged(A, B2);
    assert.equal(sh(world.remote, "rev-parse", "main").trim(), sh(B2.dir, "rev-parse", "HEAD").trim());
  });

  test("8. unreachable remote: offline, local commits kept, later sync pushes them", async () => {
    const { A, B } = await pair();
    sh(A.dir, "remote", "set-url", "origin", "http://127.0.0.1:9/nowhere.git");
    A.write("a.md", "# A\n\nwritten offline\n");
    const st = await A.sync();
    assert.equal(st.state, "offline");
    assert.equal(st.ahead, 1);
    assert.match(sh(A.dir, "log", "-1", "--format=%s"), /^auto: /);
    sh(A.dir, "remote", "set-url", "origin", world.remote);
    assert.equal((await A.sync()).state, "synced");
    await B.sync();
    assert.equal(B.read("a.md"), "# A\n\nwritten offline\n");
  });

  test("9. sync requested while another runs: operations are serialised", async () => {
    let active = 0;
    let maxActive = 0;
    const A = world.machine("A", {}, {
      onSpawn: () => {
        active++;
        maxActive = Math.max(maxActive, active);
      },
      onExit: () => {
        active--;
      },
    });
    A.write("a.md", "# A\n");
    const results = await Promise.all([A.sync(), A.sync(), A.sync(), A.sync()]);
    for (const r of results) assert.equal(r.state, "synced");
    assert.equal(maxActive, 1);
    // Requests 2-4 arrived while 1 was running, so they coalesce into one extra run.
    assert.equal(results[1], results[3]);
  });

  test("10. mid-merge failure aborts and leaves working tree and local commits intact", async () => {
    const { A } = await pair();
    let fail = true;
    const B = world.machine("B", {
      duringResolve: () => {
        if (fail) throw new Error("injected failure");
      },
    });
    A.write("a.md", "# A\n\nline 1 from A\n");
    await A.sync();
    B.write("a.md", "# A\n\nline 1 from B\n");
    const st = await B.sync();
    assert.equal(st.state, "error");
    assert.match(st.message ?? "", /aborted/);
    // Not mid-merge, local commit present, file has B's text, nothing uncommitted.
    assert.throws(() => sh(B.dir, "rev-parse", "-q", "--verify", "MERGE_HEAD"));
    assert.match(sh(B.dir, "log", "-1", "--format=%s").trim(), /^auto: .* B$/);
    assert.equal(B.read("a.md"), "# A\n\nline 1 from B\n");
    assert.equal(sh(B.dir, "status", "--porcelain").trim(), "");
    // Once the problem goes away, the next sync completes.
    fail = false;
    assert.equal((await B.sync()).state, "conflict");
    assertNoMarkers(B);
  });

  test("no remote configured: commits locally and reports local", async () => {
    const A = world.machine("A");
    sh(A.dir, "remote", "remove", "origin");
    A.write("a.md", "# A\n");
    const st = await A.sync();
    assert.equal(st.state, "local");
    assert.match(sh(A.dir, "log", "-1", "--format=%s"), /^auto: /);
  });

  test("refuses to touch a repo a human left mid-merge", async () => {
    const { A, B } = await pair();
    A.write("a.md", "# A\n\nA\n");
    await A.sync();
    B.write("a.md", "# A\n\nB\n");
    sh(B.dir, "commit", "-qam", "manual");
    sh(B.dir, "fetch", "-q");
    try {
      sh(B.dir, "merge", "origin/main");
    } catch {
      /* expected conflict */
    }
    const st = await B.sync();
    assert.equal(st.state, "error");
    assert.match(st.message ?? "", /unfinished merge/);
    assert.ok(sh(B.dir, "rev-parse", "-q", "--verify", "MERGE_HEAD").trim());
  });
});

describe("helpers", () => {
  test("classifyGitError", () => {
    assert.equal(classifyGitError("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository."), "auth");
    assert.equal(classifyGitError("fatal: unable to access 'https://github.com/x/y/': Could not resolve host: github.com"), "network");
    assert.equal(classifyGitError(" ! [rejected]        HEAD -> main (fetch first)\nerror: failed to push some refs"), "rejected");
    assert.equal(classifyGitError(" ! [remote rejected] HEAD -> main (protected branch hook declined)"), "other");
    assert.equal(classifyGitError("remote: error: cannot lock ref 'refs/heads/main': is at 1 but expected 2\n ! [remote rejected] HEAD -> main (failed to update ref)"), "rejected");
    assert.equal(classifyGitError("fatal: '/x.git' does not appear to be a git repository\nfatal: Could not read from remote repository."), "other");
    assert.equal(classifyGitError("remote: Repository not found.\nfatal: repository 'https://github.com/a/b.git/' not found"), "other");
    assert.equal(classifyGitError("fatal: could not read Username for 'https://github.com': terminal prompts disabled"), "auth");
  });

  test("isConflictCopy", () => {
    assert.equal(isConflictCopy("a (conflict 2026-11-27 pi).md"), true);
    assert.equal(isConflictCopy("notes/a (conflict 2026-11-27 pi) 2.md"), true);
    assert.equal(isConflictCopy("a conflict.md"), false);
  });
});
