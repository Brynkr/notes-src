import assert from "node:assert/strict";
import { test } from "node:test";
import { Workspace } from "../../web/state/workspace.ts";

test("swap: dragging a pane's title bar onto another swaps their places and keeps both notes", () => {
  const ws = new Workspace(null);
  ws.open("Home/a.md");
  ws.openToSide("Home/b.md");
  ws.openToSide("Work/c.py");
  const [p1, p2, p3] = ws.state.panes.map((p) => p.id);
  const changes: boolean[] = [];
  ws.onChange((_s, structural) => changes.push(structural));

  ws.swap(p1, p3);
  assert.deepEqual(ws.state.panes.map((p) => p.notePath), ["Work/c.py", "Home/b.md", "Home/a.md"]);
  assert.deepEqual(ws.state.panes.map((p) => p.id), [p3, p2, p1], "same panes (editors survive), new places");
  assert.equal(ws.state.activePaneId, p1, "the moved pane is active");
  assert.equal(ws.state.layout, "3");
  assert.deepEqual(changes, [true]);

  ws.swap(p1, p1);
  ws.swap(p1, "nope");
  assert.equal(changes.length, 1, "no-ops don't re-render");
});

test("open in a given pane: a note dropped on a pane opens there and makes it active", () => {
  const ws = new Workspace(null);
  ws.open("Home/a.md");
  ws.openToSide("Home/b.md");
  const [left] = ws.state.panes.map((p) => p.id);
  ws.open("Home/c.md", left);
  assert.deepEqual(ws.state.panes.map((p) => p.notePath), ["Home/c.md", "Home/b.md"]);
  assert.equal(ws.state.activePaneId, left);
});
