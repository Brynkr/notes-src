// Wiki links: [[Note title]], [[Note title|shown text]], [[Note title#Heading]].
// Links point at a note's title (its first H1). Filenames also work, which
// is handy for notes without a heading: [[20261127-091500-shopping]].

export interface WikiLink {
  /** The note being linked to, as written (without alias or heading). */
  target: string;
  heading: string | null;
  alias: string | null;
  /** Offsets of the whole [[...]] in the text. */
  from: number;
  to: number;
}

const LINK_RE = /\[\[([^\[\]\n|#]+?)(?:#([^\[\]\n|]*))?(?:\|([^\[\]\n]*))?\]\]/g;

/** Find wiki links, skipping fenced code blocks and inline code. */
export function parseWikiLinks(text: string): WikiLink[] {
  const links: WikiLink[] = [];
  const skip = codeRanges(text);
  LINK_RE.lastIndex = 0;
  for (let m = LINK_RE.exec(text); m; m = LINK_RE.exec(text)) {
    const from = m.index;
    if (skip.some(([a, b]) => from >= a && from < b)) continue;
    const target = m[1].trim();
    if (!target) continue;
    links.push({ target, heading: m[2]?.trim() || null, alias: m[3]?.trim() || null, from, to: from + m[0].length });
  }
  return links;
}

/** Character ranges inside ``` / ~~~ fences or `inline code`. */
function codeRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  const fence = /^[ \t]{0,3}(```|~~~)[^\n]*\n[\s\S]*?(?:^[ \t]{0,3}\1[^\n]*$|(?![\s\S]))/gm;
  for (let m = fence.exec(text); m; m = fence.exec(text)) ranges.push([m.index, m.index + m[0].length]);
  const inline = /`[^`\n]+`/g;
  for (let m = inline.exec(text); m; m = inline.exec(text)) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

/** Normalise a title or link target for comparison. */
export function linkKey(s: string): string {
  return s
    .normalize("NFKC")
    .trim()
    .replace(/\.(md|markdown)$/i, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** Every key under which a note can be linked: its title, its filename, its filename without the timestamp. */
export function keysForNote(path: string, title: string): string[] {
  const base = path.slice(path.lastIndexOf("/") + 1).replace(/\.(md|markdown)$/i, "");
  const keys = new Set([linkKey(title), linkKey(base), linkKey(path)]);
  const slug = base.replace(/^\d{8}-\d{6}-/, "");
  if (slug !== base) keys.add(linkKey(slug));
  return [...keys].filter(Boolean);
}

export interface Linkable {
  path: string;
  title: string;
  modifiedMs: number;
  conflict?: boolean;
}

/**
 * Resolve a link target to a note. Title matches win over filename matches;
 * among equals, real notes beat conflict copies, then the newest wins.
 */
export function resolveLink<T extends Linkable>(target: string, notes: T[]): T | null {
  const key = linkKey(target);
  if (!key) return null;
  let best: T | null = null;
  let bestRank = -1;
  for (const n of notes) {
    let rank = -1;
    if (linkKey(n.title) === key) rank = 2;
    else if (keysForNote(n.path, n.title).includes(key)) rank = 1;
    if (rank < 0) continue;
    if (n.conflict) rank -= 0.5;
    if (rank > bestRank || (rank === bestRank && best && n.modifiedMs > best.modifiedMs)) {
      best = n;
      bestRank = rank;
    }
  }
  return best;
}
