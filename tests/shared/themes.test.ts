import assert from "node:assert/strict";
import { test } from "node:test";
import { contrast, THEMES } from "../../web/appearance/themes.ts";

// WCAG: 4.5:1 for normal text, 3:1 for large text and UI parts.
const RULES: [keyof (typeof THEMES)[number]["colors"], keyof (typeof THEMES)[number]["colors"], number][] = [
  ["ink", "bg", 12],
  ["ink", "panel", 11],
  ["muted", "bg", 4.5],
  ["muted", "panel", 4.5],
  ["accent", "bg", 4.5],
  ["accent", "panel", 4.2],
  ["onAccent", "accent", 4.5],
  ["bad", "bg", 4.5],
  ["ok", "bg", 4.5],
  ["warn", "bg", 4.5],
  ["warn", "warnBg", 3.5],
  ["ink", "warnBg", 9],
  ["ink", "mark", 4.5],
  ["string", "bg", 4.5],
  ["faint", "bg", 2],
];

test("16 themes, unique ids, light and dark", () => {
  assert.equal(THEMES.length, 16);
  assert.equal(new Set(THEMES.map((t) => t.id)).size, 16);
  assert.equal(THEMES.filter((t) => t.dark).length, 8);
});

test("every theme is readable", () => {
  const problems: string[] = [];
  for (const t of THEMES) {
    for (const [fg, bg, min] of RULES) {
      const ratio = contrast(t.colors[fg], t.colors[bg]);
      if (ratio < min) problems.push(`${t.id}: ${fg} on ${bg} = ${ratio.toFixed(2)} (needs ${min})`);
    }
  }
  assert.deepEqual(problems, []);
});
