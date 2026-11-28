// The language parsers (most of the editor's size). Loaded on demand by
// lazylang.ts: never for notes without code blocks, and not until IDE mode or
// a code fence needs one. Highlighting only: no linters, nothing runs.

import { cpp } from "@codemirror/lang-cpp";
import { css } from "@codemirror/lang-css";
import { go } from "@codemirror/lang-go";
import { html } from "@codemirror/lang-html";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { sql } from "@codemirror/lang-sql";
import { yaml } from "@codemirror/lang-yaml";
import { indentUnit, LanguageSupport, StreamLanguage } from "@codemirror/language";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import type { Extension } from "@codemirror/state";

type Support = LanguageSupport | StreamLanguage<unknown>;

/** Language support by a short key. Built lazily and cached: each is a parser instance. */
const makers: Record<string, () => Support> = {
  python: () => python(),
  c: () => cpp(),
  cpp: () => cpp(),
  js: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  ts: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  json: () => json(),
  rust: () => rust(),
  java: () => java(),
  go: () => go(),
  sql: () => sql(),
  yaml: () => yaml(),
  html: () => html(),
  css: () => css(),
  shell: () => StreamLanguage.define(shell),
  powershell: () => StreamLanguage.define(powerShell),
  toml: () => StreamLanguage.define(toml),
  lua: () => StreamLanguage.define(lua),
};
const cache = new Map<string, Support>();
function support(key: string): Support | null {
  if (!makers[key]) return null;
  let s = cache.get(key);
  if (!s) cache.set(key, (s = makers[key]()));
  return s;
}

/** Highlighting (and indent width) for a language key ("python"), or nothing if unknown. */
export function extensionFor(key: string): Extension {
  const s = support(key);
  if (!s) return [];
  return [s, key === "python" ? indentUnit.of("    ") : []];
}

/** The same, as LanguageSupport (what Markdown's code fences load). */
export function languageSupportFor(key: string): LanguageSupport | null {
  const s = support(key);
  if (!s) return null;
  return s instanceof StreamLanguage ? new LanguageSupport(s) : s;
}
