// Fuzzy matching for the quick switcher: query characters must appear in
// order (not necessarily together). Matches at word starts and runs of
// consecutive characters score higher. Case- and accent-insensitive.

export interface FuzzyMatch {
  score: number;
  /** Indices into the target string of the matched characters. */
  positions: number[];
}

/** Fold one character: lowercase, accents removed. Keeps a 1:1 index mapping. */
function foldChar(c: string): string {
  const f = c.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  return f.length ? f[0] : c;
}

function isWordStart(t: string[], i: number): boolean {
  if (i === 0) return true;
  const prev = t[i - 1];
  const cur = t[i];
  if (/[\s\-_/.,:;()[\]'"]/.test(prev)) return true;
  // camelCase or letter after digit
  return prev.toLowerCase() === prev && cur.toUpperCase() === cur && cur.toLowerCase() !== cur;
}

export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  const q = [...query.replace(/\s+/g, "")].map(foldChar).join("");
  if (!q) return { score: 0, positions: [] };
  const chars = [...target];
  const folded = chars.map(foldChar);

  // Forward pass: earliest position where the whole query has matched.
  let qi = 0;
  let end = -1;
  for (let ti = 0; ti < folded.length; ti++) {
    if (folded[ti] === q[qi]) {
      qi++;
      if (qi === q.length) {
        end = ti;
        break;
      }
    }
  }
  if (end < 0) return null;

  // Backward pass: tightest start for that end.
  qi = q.length - 1;
  let start = end;
  for (let ti = end; ti >= 0; ti--) {
    if (folded[ti] === q[qi]) {
      qi--;
      if (qi < 0) {
        start = ti;
        break;
      }
    }
  }

  // Prefer a word-start or exact-substring alignment if one exists anywhere.
  const joined = folded.join("");
  const sub = findBestSubstring(joined, q, chars);
  let positions: number[];
  if (sub >= 0) {
    positions = Array.from({ length: q.length }, (_, i) => sub + i);
  } else {
    positions = [];
    qi = 0;
    for (let ti = start; ti <= end && qi < q.length; ti++) {
      if (folded[ti] === q[qi]) {
        positions.push(ti);
        qi++;
      }
    }
  }

  let score = 0;
  let prev = -2;
  for (const p of positions) {
    score += 1;
    if (p === prev + 1) score += 4;
    if (isWordStart(chars, p)) score += 6;
    if (p === 0) score += 4;
    prev = p;
  }
  const span = positions[positions.length - 1] - positions[0] + 1;
  score -= (span - q.length) * 0.3;
  score -= chars.length * 0.02;
  if (sub >= 0) score += 10;
  if (joined === q) score += 20;
  // Map code-point positions back to UTF-16 indices for highlighting.
  const offsets: number[] = [];
  let acc = 0;
  for (const c of chars) {
    offsets.push(acc);
    acc += c.length;
  }
  return { score, positions: positions.map((p) => offsets[p]) };
}

/** Index of q as a substring of folded target, preferring a word-start occurrence; -1 if none. */
function findBestSubstring(folded: string, q: string, original: string[]): number {
  let best = -1;
  for (let i = folded.indexOf(q); i >= 0; i = folded.indexOf(q, i + 1)) {
    if (isWordStart(original, i)) return i;
    if (best < 0) best = i;
  }
  return best;
}

export interface Ranked<T> {
  item: T;
  match: FuzzyMatch;
}

/** Rank items by fuzzy score on `key`, ties broken by `recency` (higher first). */
export function fuzzyRank<T>(query: string, items: T[], key: (t: T) => string, recency: (t: T) => number, limit = 50): Ranked<T>[] {
  const out: Ranked<T>[] = [];
  for (const item of items) {
    const match = fuzzyMatch(query, key(item));
    if (match) out.push({ item, match });
  }
  out.sort((a, b) => b.match.score - a.match.score || recency(b.item) - recency(a.item));
  return out.slice(0, limit);
}
