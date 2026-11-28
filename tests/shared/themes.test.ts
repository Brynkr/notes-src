import assert from "node:assert/strict";
import { test } from "node:test";
import { colorblindColors, contrast, THEMES } from "../../web/appearance/themes.ts";

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

test("32 themes, unique ids and names, half light and half dark", () => {
  assert.equal(THEMES.length, 32);
  assert.equal(new Set(THEMES.map((t) => t.id)).size, 32);
  assert.equal(new Set(THEMES.map((t) => t.name)).size, 32);
  assert.equal(THEMES.filter((t) => t.dark).length, 16);
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

test("colour-blind option: blue / vermillion / purple, readable in every theme, and distinct from each other", () => {
  const problems: string[] = [];
  for (const t of THEMES) {
    const cb = colorblindColors(t);
    const c = { ...t.colors, ...cb };
    for (const [fg, bg, min] of RULES) {
      if (!(fg in cb)) continue;
      const ratio = contrast(c[fg], c[bg]);
      if (ratio < min) problems.push(`${t.id} (colour-blind): ${fg} on ${bg} = ${ratio.toFixed(2)} (needs ${min})`);
    }
    if (new Set([cb.ok, cb.bad, cb.warn]).size !== 3) problems.push(`${t.id}: colour-blind colours not distinct`);
  }
  assert.deepEqual(problems, []);
});
