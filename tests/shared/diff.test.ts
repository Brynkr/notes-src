import assert from "node:assert/strict";
import { test } from "node:test";
import { lineDiff } from "../../shared/diff.ts";

const show = (a: string, b: string) => lineDiff(a, b).map((o) => ({ same: " ", add: "+", del: "-" })[o.kind] + o.line);

test("lineDiff marks additions and removals with shared context", () => {
  assert.deepEqual(show("a\nb\nc", "a\nB\nc\nd"), [" a", "-b", "+B", " c", "+d"]);
  assert.deepEqual(show("same", "same"), [" same"]);
  assert.deepEqual(show("", "x"), ["-", "+x"]);
});

test("lineDiff applied to `from` yields `to`", () => {
  const from = "# T\n\none\ntwo\nthree\nfour\n";
  const to = "# T\n\nzero\none\nthree\nfour and more\n";
  const ops = lineDiff(from, to);
  assert.equal(ops.filter((o) => o.kind !== "del").map((o) => o.line).join("\n"), to);
  assert.equal(ops.filter((o) => o.kind !== "add").map((o) => o.line).join("\n"), from);
});
