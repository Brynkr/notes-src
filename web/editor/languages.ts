// Syntax highlighting for code files (IDE mode) and for fenced code blocks in
// notes. Highlighting only: no linters, nothing runs. Colours come from the
// theme variables, so every theme works.

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
import { HighlightStyle, indentUnit, StreamLanguage, type Language, type LanguageSupport } from "@codemirror/language";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import type { Extension } from "@codemirror/state";
import { tags as t } from "@lezer/highlight";
import { extOf } from "../../shared/files.ts";

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

/** File extension, or a code fence's info string ("```python"), → language key. */
const ALIASES: Record<string, string> = {
  py: "python", pyw: "python", python: "python",
  c: "c", h: "c",
  cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp", ino: "cpp", "c++": "cpp",
  js: "js", mjs: "js", cjs: "js", javascript: "js", node: "js",
  jsx: "jsx",
  ts: "ts", mts: "ts", cts: "ts", typescript: "ts",
  tsx: "tsx",
  json: "json", jsonc: "json",
  rs: "rust", rust: "rust",
  java: "java",
  go: "go", golang: "go",
  sql: "sql",
  yaml: "yaml", yml: "yaml",
  html: "html", htm: "html",
  css: "css",
  sh: "shell", bash: "shell", zsh: "shell", shell: "shell", console: "shell",
  ps1: "powershell", psm1: "powershell", powershell: "powershell", pwsh: "powershell",
  toml: "toml",
  lua: "lua",
};

/** Highlighting (and indent width) for a code file, or nothing for plain text. */
export function languageForPath(path: string): Extension {
  const key = ALIASES[extOf(path)];
  const s = key ? support(key) : null;
  if (!s) return [];
  return [s, key === "python" ? indentUnit.of("    ") : []];
}

/** For Markdown's fenced code blocks: "```py" → the Python parser. */
export function fenceLanguage(info: string): Language | null {
  const key = ALIASES[info.trim().split(/\s+/)[0]?.toLowerCase() ?? ""];
  const s = key ? support(key) : null;
  if (!s) return null;
  return s instanceof StreamLanguage ? s : s.language;
}

/** Code colours from the theme: accent keywords, string colour for literals, quiet comments. */
export const codeHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword, t.modifier], color: "var(--accent)" },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: "var(--string)" },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit], color: "var(--ok)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--faint)", fontStyle: "italic" },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: "var(--warn)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], fontWeight: "600" },
  { tag: [t.meta, t.annotation, t.processingInstruction], color: "var(--muted)" },
  { tag: [t.tagName, t.angleBracket], color: "var(--accent)" },
  { tag: t.attributeName, color: "var(--warn)" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "var(--muted)" },
  { tag: t.invalid, color: "var(--bad)" },
]);
