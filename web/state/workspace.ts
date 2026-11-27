// Workspace state: layout preset, panes, active pane. Always an array of
// panes, never a single global editor. Persisted per browser in localStorage
// (window state is per device, so it never goes into the notes repo).

export type LayoutPreset = "1" | "2v" | "2h" | "3" | "2x2";

export interface PaneState {
  id: string;
  notePath: string | null;
  cursor: { anchor: number; head: number };
  scrollTop: number;
}

export interface WorkspaceState {
  layout: LayoutPreset;
  panes: PaneState[];
  activePaneId: string;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
}

export const PRESET_SIZE: Record<LayoutPreset, number> = { "1": 1, "2v": 2, "2h": 2, "3": 3, "2x2": 4 };
export const PRESETS: LayoutPreset[] = ["1", "2v", "2h", "3", "2x2"];

const KEY = "notes-app:workspace:v1";

let counter = 0;
export function newPane(notePath: string | null = null): PaneState {
  counter++;
  return { id: `p${Date.now().toString(36)}${counter}`, notePath, cursor: { anchor: 0, head: 0 }, scrollTop: 0 };
}

export function defaultState(): WorkspaceState {
  const p = newPane();
  return { layout: "1", panes: [p], activePaneId: p.id, sidebarWidth: 280, sidebarCollapsed: false };
}

/** Preset for a pane count, preferring the current orientation for two panes. */
export function presetFor(count: number, current: LayoutPreset): LayoutPreset {
  if (count <= 1) return "1";
  if (count === 2) return current === "2h" ? "2h" : "2v";
  if (count === 3) return "3";
  return "2x2";
}

export function validate(raw: unknown): WorkspaceState {
  const d = defaultState();
  if (!raw || typeof raw !== "object") return d;
  const s = raw as Partial<WorkspaceState>;
  const layout = PRESETS.includes(s.layout as LayoutPreset) ? (s.layout as LayoutPreset) : "1";
  let panes = Array.isArray(s.panes)
    ? s.panes
        .filter((p) => p && typeof p.id === "string")
        .map((p) => ({
          id: p.id,
          notePath: typeof p.notePath === "string" ? p.notePath : null,
          cursor: { anchor: Number(p.cursor?.anchor) || 0, head: Number(p.cursor?.head) || 0 },
          scrollTop: Number(p.scrollTop) || 0,
        }))
    : [];
  const n = PRESET_SIZE[layout];
  panes = panes.slice(0, n);
  while (panes.length < n) panes.push(newPane());
  const activePaneId = panes.some((p) => p.id === s.activePaneId) ? (s.activePaneId as string) : panes[0].id;
  return {
    layout,
    panes,
    activePaneId,
    sidebarWidth: Math.min(600, Math.max(180, Number(s.sidebarWidth) || d.sidebarWidth)),
    sidebarCollapsed: Boolean(s.sidebarCollapsed),
  };
}

type Listener = (s: WorkspaceState, structural: boolean) => void;

export class Workspace {
  state: WorkspaceState;
  private listeners: Listener[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly storage: Storage | null;

  constructor(storage: Storage | null = typeof localStorage === "undefined" ? null : localStorage) {
    this.storage = storage;
    let raw: unknown = null;
    try {
      raw = JSON.parse(storage?.getItem(KEY) ?? "null");
    } catch {
      raw = null;
    }
    this.state = validate(raw);
  }

  onChange(fn: Listener): void {
    this.listeners.push(fn);
  }

  /** structural = panes or layout changed (needs re-render), not just a cursor move. */
  private commit(structural: boolean): void {
    for (const fn of this.listeners) fn(this.state, structural);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.persist(), structural ? 0 : 500);
  }

  persist(): void {
    try {
      this.storage?.setItem(KEY, JSON.stringify(this.state));
    } catch {
      /* ignore */
    }
  }

  get active(): PaneState {
    return this.state.panes.find((p) => p.id === this.state.activePaneId) ?? this.state.panes[0];
  }

  pane(id: string): PaneState | undefined {
    return this.state.panes.find((p) => p.id === id);
  }

  setActive(id: string): void {
    if (this.state.activePaneId === id || !this.pane(id)) return;
    this.state = { ...this.state, activePaneId: id };
    this.commit(true);
  }

  focusIndex(i: number): void {
    const p = this.state.panes[i];
    if (p) this.setActive(p.id);
  }

  /** Open a note in the active pane (or a given pane), optionally with the cursor at `at`. */
  open(path: string, paneId = this.state.activePaneId, at = 0): void {
    this.state = {
      ...this.state,
      activePaneId: paneId,
      panes: this.state.panes.map((p) => (p.id === paneId ? { ...p, notePath: path, cursor: { anchor: at, head: at }, scrollTop: 0 } : p)),
    };
    this.commit(true);
  }

  /** "Open to the side": add a pane next to the active one, growing the layout. */
  openToSide(path: string | null, at = 0): void {
    const { panes, layout } = this.state;
    const idx = panes.findIndex((p) => p.id === this.state.activePaneId);
    if (panes.length >= 4) {
      const target = panes[(idx + 1) % panes.length];
      if (path) this.open(path, target.id, at);
      else this.setActive(target.id);
      return;
    }
    const p = newPane(path);
    p.cursor = { anchor: at, head: at };
    const next = [...panes.slice(0, idx + 1), p, ...panes.slice(idx + 1)];
    this.state = { ...this.state, panes: next, layout: presetFor(next.length, layout), activePaneId: p.id };
    this.commit(true);
  }

  /** Close a pane and collapse to the next smaller preset. The last pane is just emptied. */
  close(id: string): void {
    const { panes, layout } = this.state;
    if (panes.length === 1) {
      this.state = { ...this.state, panes: [{ ...panes[0], notePath: null }] };
      this.commit(true);
      return;
    }
    const idx = panes.findIndex((p) => p.id === id);
    if (idx < 0) return;
    const next = panes.filter((p) => p.id !== id);
    const activePaneId = this.state.activePaneId === id ? next[Math.max(0, idx - 1)].id : this.state.activePaneId;
    this.state = { ...this.state, panes: next, layout: presetFor(next.length, layout), activePaneId };
    this.commit(true);
  }

  setLayout(layout: LayoutPreset): void {
    const n = PRESET_SIZE[layout];
    let panes = this.state.panes;
    if (panes.length > n) {
      // Keep the active pane visible when shrinking.
      const active = this.active;
      const rest = panes.filter((p) => p.id !== active.id);
      panes = [active, ...rest].slice(0, n);
      const order = this.state.panes.filter((p) => panes.includes(p));
      panes = order;
    }
    while (panes.length < n) panes = [...panes, newPane()];
    const activePaneId = panes.some((p) => p.id === this.state.activePaneId) ? this.state.activePaneId : panes[0].id;
    this.state = { ...this.state, layout, panes, activePaneId };
    this.commit(true);
  }

  /** A note disappeared: empty every pane showing it. */
  noteGone(path: string): void {
    if (!this.state.panes.some((p) => p.notePath === path)) return;
    this.state = { ...this.state, panes: this.state.panes.map((p) => (p.notePath === path ? { ...p, notePath: null } : p)) };
    this.commit(true);
  }

  saveView(id: string, cursor: { anchor: number; head: number }, scrollTop: number): void {
    const p = this.pane(id);
    if (!p) return;
    p.cursor = cursor;
    p.scrollTop = scrollTop;
    this.commit(false);
  }

  setSidebar(patch: Partial<Pick<WorkspaceState, "sidebarWidth" | "sidebarCollapsed">>): void {
    this.state = { ...this.state, ...patch };
    this.commit(false);
  }
}
