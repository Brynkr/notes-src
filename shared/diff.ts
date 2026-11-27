// Line diff for the history view.

export type Op = { kind: "same" | "add" | "del"; line: string };

/** Changes that turn `from` into `to`, by lines (LCS). Falls back to whole-text replace when huge. */
export function lineDiff(from: string, to: string): Op[] {
  const a = from.split("\n");
  const b = to.split("\n");
  // Trim common head/tail so the table stays small for typical edits.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const ops: Op[] = a.slice(0, start).map((line) => ({ kind: "same", line }));
  if (midA.length * midB.length > 4_000_000) {
    ops.push(...midA.map((line) => ({ kind: "del" as const, line })), ...midB.map((line) => ({ kind: "add" as const, line })));
  } else {
    const n = midA.length;
    const m = midB.length;
    const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        ops.push({ kind: "same", line: midA[i] });
        i++;
        j++;
      } else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1])) {
        ops.push({ kind: "del", line: midA[i++] });
      } else {
        ops.push({ kind: "add", line: midB[j++] });
      }
    }
  }
  ops.push(...a.slice(endA).map((line) => ({ kind: "same" as const, line })));
  return ops;
}

