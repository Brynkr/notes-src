// Small and always loaded: which language a file or code fence is, and
// loading its parser (languages.ts) only when one is actually needed.

import { LanguageDescription } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { extOf } from "../../shared/files.ts";

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

let parsers: Promise<typeof import("./languages.ts")> | null = null;
const loadParsers = () => (parsers ??= import("./languages.ts"));

/** Highlighting for a code file's language, loaded on demand (nothing for plain text). */
export async function loadLanguageForPath(path: string): Promise<Extension> {
  const key = ALIASES[extOf(path)];
  if (!key) return [];
  return (await loadParsers()).extensionFor(key);
}

const fences = new Map<string, LanguageDescription>();

/** For Markdown's code fences: "```py" → a description whose parser loads the first time it's used. */
export function fenceLanguage(info: string): LanguageDescription | null {
  const key = ALIASES[info.trim().split(/s+/)[0]?.toLowerCase() ?? ""];
  if (!key) return null;
  let d = fences.get(key);
  if (!d) {
    d = LanguageDescription.of({
      name: key,
      load: async () => {
        const s = (await loadParsers()).languageSupportFor(key);
        if (!s) throw new Error(`no parser for ${key}`);
        return s;
      },
    });
    fences.set(key, d);
  }
  return d;
}
