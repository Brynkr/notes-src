import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fuzzyMatch, fuzzyRank } from "../../shared/fuzzy.ts";

describe("fuzzyMatch", () => {
  test("subsequence, case and accent insensitive", () => {
    assert.ok(fuzzyMatch("shpl", "Shopping list"));
    assert.ok(fuzzyMatch("TAWH", "Tāwharanui walk"));
    assert.equal(fuzzyMatch("xyz", "Shopping list"), null);
    assert.equal(fuzzyMatch("lists", "Shopping list"), null);
  });

  test("empty query matches everything", () => {
    assert.deepEqual(fuzzyMatch("", "anything"), { score: 0, positions: [] });
  });

  test("positions point at the matched characters", () => {
    const m = fuzzyMatch("sl", "Shopping list")!;
    assert.deepEqual(m.positions, [0, 9]);
    const sub = fuzzyMatch("list", "Shopping list")!;
    assert.deepEqual(sub.positions, [9, 10, 11, 12]);
  });

  test("spaces in the query are ignored", () => {
    assert.ok(fuzzyMatch("shop list", "Shopping list"));
  });

  test("ranks word starts and substrings above scattered matches", () => {
    const items = ["Fish recipes", "Reading list", "Raspberry Pi setup", "Recipes to try", "Garden plan"];
    const ranked = fuzzyRank("rec", items, (s) => s, () => 0).map((r) => r.item);
    assert.equal(ranked[0], "Recipes to try");
    assert.ok(ranked.indexOf("Fish recipes") < ranked.indexOf("Raspberry Pi setup") || !ranked.includes("Raspberry Pi setup"));
    assert.deepEqual(fuzzyRank("rps", items, (s) => s, () => 0).map((r) => r.item)[0], "Raspberry Pi setup");
  });

  test("ties broken by recency", () => {
    const items = [
      { t: "Weekly plan", m: 1 },
      { t: "Weekly plan", m: 5 },
    ];
    assert.equal(fuzzyRank("week", items, (i) => i.t, (i) => i.m)[0].item.m, 5);
  });

  test("handles astral characters without breaking positions", () => {
    const m = fuzzyMatch("pl", "🌱 plants")!;
    assert.deepEqual(m.positions, [3, 4]);
  });
});
