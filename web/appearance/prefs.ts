// Appearance preferences: theme, fonts, text layout, borders, corners,
// density, editor options and text zoom. Saved per device (localStorage),
// applied as CSS variables and data attributes on <html>.

import { DARK_DEFAULT, LIGHT_DEFAULT, SYSTEM_THEME, themeById, type Theme } from "./themes.ts";

export const FONTS = {
  serif: { name: "Book serif", stack: 'Charter, "Bitstream Charter", "Iowan Old Style", "Sitka Text", Cambria, Georgia, serif' },
  sans: { name: "Sans", stack: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif' },
  humanist: { name: "Humanist", stack: 'Seravek, "Gill Sans Nova", "Segoe UI Variable Text", Ubuntu, "Fira Sans", Candara, "DejaVu Sans", sans-serif' },
  slab: { name: "Slab", stack: 'Rockwell, "Roboto Slab", "Zilla Slab", "Museo Slab", "DejaVu Serif", Georgia, serif' },
  mono: { name: "Typewriter", stack: 'ui-monospace, "Cascadia Code", "SF Mono", "JetBrains Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace' },
} as const;
export type EditorFont = keyof typeof FONTS;

export const LINE_HEIGHTS = { compact: 1.45, normal: 1.65, relaxed: 1.9 } as const;
export const WIDTHS = { narrow: "60ch", normal: "74ch", wide: "96ch", full: "none" } as const;
export const RADII = {
  square: ["2px", "3px", "4px"],
  soft: ["6px", "8px", "14px"],
  round: ["10px", "14px", "22px"],
} as const;

export interface Appearance {
  theme: string;
  editorFont: EditorFont;
  uiFont: "system" | "editor";
  lineHeight: keyof typeof LINE_HEIGHTS;
  width: keyof typeof WIDTHS;
  borders: "none" | "subtle" | "strong" | "cards";
  corners: keyof typeof RADII;
  density: "compact" | "comfortable" | "spacious";
  lineNumbers: boolean;
  activeLine: boolean;
  spellcheck: boolean;
  motion: boolean;
  /** Text zoom for notes, 0.7–2. */
  zoom: number;
}

export const DEFAULTS: Appearance = {
  theme: SYSTEM_THEME,
  editorFont: "serif",
  uiFont: "system",
  lineHeight: "normal",
  width: "normal",
  borders: "subtle",
  corners: "soft",
  density: "comfortable",
  lineNumbers: false,
  activeLine: true,
  spellcheck: true,
  motion: true,
  zoom: 1,
};

export const ZOOM_MIN = 0.7;
export const ZOOM_MAX = 2;
const KEY = "notes-app:appearance:v1";

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

export function clampZoom(z: number): number {
  return Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) * 100) / 100;
}

export function validate(raw: unknown): Appearance {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Appearance>;
  const d = DEFAULTS;
  return {
    theme: typeof r.theme === "string" && (r.theme === SYSTEM_THEME || themeById(r.theme)) ? r.theme : d.theme,
    editorFont: oneOf(r.editorFont, Object.keys(FONTS) as EditorFont[], d.editorFont),
    uiFont: oneOf(r.uiFont, ["system", "editor"] as const, d.uiFont),
    lineHeight: oneOf(r.lineHeight, Object.keys(LINE_HEIGHTS) as Appearance["lineHeight"][], d.lineHeight),
    width: oneOf(r.width, Object.keys(WIDTHS) as Appearance["width"][], d.width),
    borders: oneOf(r.borders, ["none", "subtle", "strong", "cards"] as const, d.borders),
    corners: oneOf(r.corners, Object.keys(RADII) as Appearance["corners"][], d.corners),
    density: oneOf(r.density, ["compact", "comfortable", "spacious"] as const, d.density),
    lineNumbers: typeof r.lineNumbers === "boolean" ? r.lineNumbers : d.lineNumbers,
    activeLine: typeof r.activeLine === "boolean" ? r.activeLine : d.activeLine,
    spellcheck: typeof r.spellcheck === "boolean" ? r.spellcheck : d.spellcheck,
    motion: typeof r.motion === "boolean" ? r.motion : d.motion,
    zoom: typeof r.zoom === "number" && Number.isFinite(r.zoom) ? clampZoom(r.zoom) : d.zoom,
  };
}

type Listener = (a: Appearance, changed: (keyof Appearance)[]) => void;

export class AppearanceStore {
  value: Appearance;
  private listeners: Listener[] = [];
  private readonly darkQuery = matchMedia("(prefers-color-scheme: dark)");

  constructor() {
    let raw: unknown = null;
    try {
      raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
    } catch {
      raw = null;
    }
    this.value = validate(raw);
    this.darkQuery.addEventListener("change", () => {
      if (this.value.theme === SYSTEM_THEME) this.apply();
    });
  }

  onChange(fn: Listener): void {
    this.listeners.push(fn);
  }

  set(patch: Partial<Appearance>): void {
    const next = validate({ ...this.value, ...patch });
    const changed = (Object.keys(next) as (keyof Appearance)[]).filter((k) => next[k] !== this.value[k]);
    if (!changed.length) return;
    this.value = next;
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* private mode or full: still applies for this session */
    }
    this.apply();
    for (const fn of this.listeners) fn(next, changed);
  }

  reset(): void {
    this.set({ ...DEFAULTS });
  }

  zoomBy(step: number): void {
    this.set({ zoom: clampZoom(this.value.zoom + step) });
  }

  /** The theme actually shown ("system" resolved to Paper or Ink). */
  resolvedTheme(): Theme {
    const id = this.value.theme === SYSTEM_THEME ? (this.darkQuery.matches ? DARK_DEFAULT : LIGHT_DEFAULT) : this.value.theme;
    return themeById(id) ?? themeById(LIGHT_DEFAULT)!;
  }

  /** Write everything onto <html>. Safe to call any time. */
  apply(): void {
    const a = this.value;
    const root = document.documentElement;
    const t = this.resolvedTheme();
    const c = t.colors;
    const vars: Record<string, string> = {
      "--bg": c.bg,
      "--panel": c.panel,
      "--panel-2": c.panel2,
      "--ink": c.ink,
      "--muted": c.muted,
      "--faint": c.faint,
      "--line": c.line,
      "--accent": c.accent,
      "--on-accent": c.onAccent,
      "--mark": c.mark,
      "--string": c.string,
      "--ok": c.ok,
      "--warn": c.warn,
      "--bad": c.bad,
      "--warn-bg": c.warnBg,
      "--shadow": t.dark ? "0 8px 30px rgba(0, 0, 0, 0.5)" : "0 6px 24px rgba(30, 25, 15, 0.14)",
      "--editor-font": FONTS[a.editorFont].stack,
      "--ui-font": a.uiFont === "editor" ? FONTS[a.editorFont].stack : FONTS.sans.stack,
      "--editor-lh": String(LINE_HEIGHTS[a.lineHeight]),
      "--editor-width": WIDTHS[a.width],
      "--zoom": String(a.zoom),
      "--r-sm": RADII[a.corners][0],
      "--r-md": RADII[a.corners][1],
      "--r-lg": RADII[a.corners][2],
    };
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    root.style.colorScheme = t.dark ? "dark" : "light";
    root.dataset.theme = t.id;
    root.dataset.borders = a.borders;
    root.dataset.density = a.density;
    root.dataset.motion = a.motion ? "on" : "off";
    for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
      meta.content = c.bg;
      meta.removeAttribute("media");
    }
  }
}
