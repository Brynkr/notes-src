// Markdown helpers shared by server and web UI (no Node APIs here).

export const NOTE_EXT = /\.(md|markdown)$/i;

const FRONT_MATTER_RE = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/** Split off YAML front matter. Returns the raw YAML (without fences) and the body. */
export function splitFrontMatter(text: string): { yaml: string | null; body: string } {
  const m = FRONT_MATTER_RE.exec(text);
  if (!m) return { yaml: null, body: text };
  return { yaml: m[1], body: text.slice(m[0].length) };
}

/** Minimal reader for `tags:` in front matter: flow list, comma string, or block list. */
export function parseTags(yaml: string | null): string[] {
  if (!yaml) return [];
  const lines = yaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^tags\s*:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const rest = m[1].trim();
    const clean = (t: string) => t.trim().replace(/^["']|["']$/g, "").trim();
    if (rest.startsWith("[")) {
      return rest.replace(/^\[|\]$/g, "").split(",").map(clean).filter(Boolean);
    }
    if (rest) return rest.split(",").map(clean).filter(Boolean);
    const tags: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const item = /^\s*-\s+(.*)$/.exec(lines[j]);
      if (!item) break;
      tags.push(clean(item[1]));
    }
    return tags.filter(Boolean);
  }
  return [];
}

/** Title: first H1, else first non-empty line, else a name derived from the filename. */
export function extractTitle(text: string, filename: string): string {
  const { body } = splitFrontMatter(text);
  let inFence = false;
  let firstLine: string | null = null;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h1 = /^\s{0,3}#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (h1) return h1[1].trim();
    if (firstLine === null && line.trim()) {
      firstLine = line.trim().replace(/^(#{1,6}|[-*+>]|\d+\.)\s+/, "").trim();
    }
  }
  if (firstLine) return firstLine.length > 80 ? firstLine.slice(0, 79) + "…" : firstLine;
  const stem = filename.slice(filename.lastIndexOf("/") + 1).replace(NOTE_EXT, "");
  const named = stem.replace(/^\d{8}-\d{6}-?/, "").replace(/[-_]+/g, " ").trim();
  return named || stem;
}

