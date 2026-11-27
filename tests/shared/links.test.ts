import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keysForNote, linkKey, parseWikiLinks, resolveLink } from "../../shared/links.ts";
import { SearchIndex } from "../../server/search.ts";

describe("wiki links", () => {
  test("parses targets, aliases and headings", () => {
    const links = parseWikiLinks("See [[Shopping list]] and [[Pi setup#To do|the todo]].\n[[ spaced  ]]");
    assert.deepEqual(
      links.map((l) => [l.target, l.heading, l.alias]),
      [
        ["Shopping list", null, null],
        ["Pi setup", "To do", "the todo"],
        ["spaced", null, null],
      ],
    );
    assert.equal("See [[Shopping list]]".slice(links[0].from, links[0].to), "[[Shopping list]]");
  });

  test("ignores links in code and malformed brackets", () => {
    const text = "`[[inline]]`\n```\n[[fenced]]\n```\n[[]] [[a\nb]] [[real]]";
    assert.deepEqual(parseWikiLinks(text).map((l) => l.target), ["real"]);
  });

  test("an unclosed fence hides links to the end", () => {
    assert.deepEqual(parseWikiLinks("```\n[[x]]\n").map((l) => l.target), []);
  });

  test("resolves by title, then filename; prefers real notes and newer ones", () => {
    const notes = [
      { path: "20261127-091500-shopping.md", title: "Shopping list", modifiedMs: 1 },
      { path: "20261127-091500-shopping (conflict 2026-11-27 pi).md", title: "Shopping list", modifiedMs: 9, conflict: true },
      { path: "20261120-080000-pi.md", title: "Raspberry Pi", modifiedMs: 2 },
      { path: "a.md", title: "Dup", modifiedMs: 1 },
      { path: "b.md", title: "Dup", modifiedMs: 5 },
    ];
    assert.equal(resolveLink("shopping  LIST", notes)?.path, "20261127-091500-shopping.md");
    assert.equal(resolveLink("20261120-080000-pi", notes)?.title, "Raspberry Pi");
    assert.equal(resolveLink("pi", notes)?.title, "Raspberry Pi");
    assert.equal(resolveLink("Dup", notes)?.path, "b.md");
    assert.equal(resolveLink("Nope", notes), null);
  });

  test("keysForNote and linkKey", () => {
    assert.equal(linkKey("  Café  Notes.md "), "café notes");
    assert.deepEqual(keysForNote("sub/20261127-091500-pi.md", "Raspberry Pi").sort(), ["20261127-091500-pi", "pi", "raspberry pi", "sub/20261127-091500-pi"]);
  });

  test("backlinks come from the search index", () => {
    const idx = new SearchIndex(":memory:");
    idx.upsert("a.md", "1", "# A\n\nGo to [[Target note]] for more.\n");
    idx.upsert("b.md", "1", "# B\n\n[[target NOTE|alias]] again\n");
    idx.upsert("c.md", "1", "# C\n\nnothing here [[Other]]\n");
    let bl = idx.backlinks(keysForNote("t.md", "Target note"));
    assert.deepEqual(bl.map((b) => b.path), ["a.md", "b.md"]);
    assert.equal(bl[0].context, "Go to [[Target note]] for more.");
    idx.upsert("a.md", "2", "# A\n\nlink removed\n");
    bl = idx.backlinks(keysForNote("t.md", "Target note"));
    assert.deepEqual(bl.map((b) => b.path), ["b.md"]);
    idx.remove("b.md");
    assert.deepEqual(idx.backlinks(keysForNote("t.md", "Target note")), []);
    idx.close();
  });
});
