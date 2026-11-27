// Conflict copies: "<stem> (conflict YYYY-MM-DD host).md" next to the original.

const CONFLICT_RE = / \(conflict (\d{4}-\d{2}-\d{2})([^)]*)\)(?: \d+)?(\.[^/.]+)$/;

export function isConflictCopy(p: string): boolean {
  return CONFLICT_RE.test(p);
}

/** "x (conflict 2026-11-27 pi).md" -> "x.md" */
export function originalOf(copy: string): string {
  return copy.replace(CONFLICT_RE, "$3");
}

/** Date and machine from a conflict copy's name, if it is one. */
export function conflictInfo(copy: string): { date: string; host: string } | null {
  const m = CONFLICT_RE.exec(copy);
  return m ? { date: m[1], host: m[2].trim() } : null;
}
