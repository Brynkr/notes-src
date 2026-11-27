// Running as a single executable (e.g. the portable Notes.exe)? Node's SEA
// feature bundles this server and the web UI's files into one binary.

type SeaModule = { isSea(): boolean; getAsset(key: string): ArrayBuffer };

function seaModule(): SeaModule | null {
  try {
    return process.getBuiltinModule("node:sea") as unknown as SeaModule;
  } catch {
    return null;
  }
}

export function isSea(): boolean {
  try {
    return seaModule()?.isSea() ?? false;
  } catch {
    return false;
  }
}

/** A file embedded in the executable, or null if there's no such asset. */
export function seaAsset(key: string): Buffer | null {
  try {
    const ab = seaModule()?.getAsset(key);
    return ab ? Buffer.from(ab) : null;
  } catch {
    return null;
  }
}
