// Home and Work modes: two top-level folders of the notes root.
// A note's mode is its first path segment (matched case-insensitively, so a
// "work" folder made by hand on Windows counts). Anything else, including
// notes at the root, belongs to Home: the server moves such notes into
// Home/ at startup, and until then they show up in Home.

export type Mode = "home" | "work";

export const MODES: readonly Mode[] = ["home", "work"];

export const MODE_FOLDER: Record<Mode, string> = { home: "Home", work: "Work" };

export const MODE_LABEL: Record<Mode, string> = { home: "Home", work: "Work" };

export function isMode(x: unknown): x is Mode {
  return x === "home" || x === "work";
}

/** The mode folder a path is in, or null if it's outside both. */
export function modeFolderOf(path: string): Mode | null {
  const first = path.split("/")[0].toLowerCase();
  if (!path.includes("/")) return null;
  for (const m of MODES) if (first === MODE_FOLDER[m].toLowerCase()) return m;
  return null;
}

export function modeOf(path: string): Mode {
  return modeFolderOf(path) ?? "home";
}

export function inMode(path: string, mode: Mode): boolean {
  return modeOf(path) === mode;
}

/** The path shown under a mode, without its mode folder ("Home/a/b.md" → "a/b.md"). */
export function pathInMode(path: string): string {
  return modeFolderOf(path) ? path.slice(path.indexOf("/") + 1) : path;
}
