// Which files the app opens. Notes are Markdown; IDE mode also opens plain
// text and source code, chosen by extension. Anything else (images, Office
// files, binaries) is never listed, opened or written by the app.

import { NOTE_EXT } from "./markdown.ts";

/** Extension → language name shown in the UI. "Plain text" means no highlighting. */
export const CODE_LANGUAGES: Record<string, string> = {
  py: "Python",
  pyw: "Python",
  c: "C",
  h: "C",
  cpp: "C++",
  cc: "C++",
  cxx: "C++",
  hpp: "C++",
  hh: "C++",
  hxx: "C++",
  ino: "C++",
  js: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  jsx: "JavaScript (JSX)",
  ts: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  tsx: "TypeScript (TSX)",
  json: "JSON",
  rs: "Rust",
  java: "Java",
  go: "Go",
  sql: "SQL",
  yaml: "YAML",
  yml: "YAML",
  html: "HTML",
  htm: "HTML",
  css: "CSS",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  ps1: "PowerShell",
  psm1: "PowerShell",
  toml: "TOML",
  lua: "Lua",
  txt: "Plain text",
  ini: "Plain text",
  cfg: "Plain text",
  conf: "Plain text",
  csv: "Plain text",
  xml: "Plain text",
  log: "Plain text",
};

export function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function isNotePath(path: string): boolean {
  return NOTE_EXT.test(path);
}

/** A note or a text/code file the app may open and save. */
export function isTextFile(path: string): boolean {
  return isNotePath(path) || Object.hasOwn(CODE_LANGUAGES, extOf(path));
}

/** "Markdown", "Python", "Plain text"… or null for files the app doesn't open. */
export function languageName(path: string): string | null {
  if (isNotePath(path)) return "Markdown";
  return CODE_LANGUAGES[extOf(path)] ?? null;
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Folders never walked: dependency and build caches that can hold thousands of files. */
export const SKIP_DIRS = new Set(["node_modules", "__pycache__", "venv", "target"]);

/** Images that can be embedded in notes (pasted images are stored as WebP). Extension → MIME type. */
export const IMAGE_TYPES: Record<string, string> = {
  webp: "image/webp",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
};

export function isImagePath(path: string): boolean {
  return Object.hasOwn(IMAGE_TYPES, extOf(path));
}

/** Images are kept small (pasted ones are shrunk first); bigger ones wouldn't sync anyway. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
