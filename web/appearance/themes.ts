// Colour themes. Each sets a few base colours; the stylesheet derives tints
// (hover, selection, code background…) from them with color-mix. Readability
// is checked by tests/shared/themes.test.ts (WCAG contrast ratios).

export interface ThemeColors {
  bg: string;
  panel: string;
  panel2: string;
  ink: string;
  muted: string;
  faint: string;
  line: string;
  accent: string;
  /** Text on a filled accent button. */
  onAccent: string;
  mark: string;
  string: string;
  ok: string;
  warn: string;
  bad: string;
  warnBg: string;
}

export interface Theme {
  id: string;
  name: string;
  dark: boolean;
  colors: ThemeColors;
}

export const THEMES: Theme[] = [
  // --- light ---------------------------------------------------------------
  {
    id: "paper",
    name: "Paper",
    dark: false,
    colors: { bg: "#fbfaf7", panel: "#f3f1ec", panel2: "#ebe8e1", ink: "#1d1b18", muted: "#66615a", faint: "#a39d92", line: "#e2ded5", accent: "#2d6a6e", onAccent: "#ffffff", mark: "#f1df9a", string: "#8a5a1f", ok: "#2f7a4c", warn: "#93600f", bad: "#b03f35", warnBg: "#fbf1dc" },
  },
  {
    id: "snow",
    name: "Snow",
    dark: false,
    colors: { bg: "#ffffff", panel: "#f4f6f9", panel2: "#e8ecf1", ink: "#16191d", muted: "#56606b", faint: "#9aa3ad", line: "#e1e6ec", accent: "#2557c7", onAccent: "#ffffff", mark: "#fde68a", string: "#9a4d12", ok: "#2a7a50", warn: "#955507", bad: "#c22f2f", warnBg: "#fdf4e3" },
  },
  {
    id: "sepia",
    name: "Sepia",
    dark: false,
    colors: { bg: "#f6eedf", panel: "#eee3cf", panel2: "#e5d8c0", ink: "#2b2116", muted: "#65533f", faint: "#a8957b", line: "#ddcfb5", accent: "#86461a", onAccent: "#ffffff", mark: "#f0d58a", string: "#7a4a1a", ok: "#44702f", warn: "#8a5408", bad: "#a3372a", warnBg: "#f3e2c0" },
  },
  {
    id: "sage",
    name: "Sage",
    dark: false,
    colors: { bg: "#f4f6f1", panel: "#e9eee4", panel2: "#dee5d6", ink: "#1c2219", muted: "#56624f", faint: "#98a38f", line: "#d8e0d0", accent: "#356434", onAccent: "#ffffff", mark: "#e8e29a", string: "#7d5a1c", ok: "#2f6e3a", warn: "#85600a", bad: "#a83c32", warnBg: "#f2edd2" },
  },
  {
    id: "rose",
    name: "Rose",
    dark: false,
    colors: { bg: "#fdf8f8", panel: "#f7edef", panel2: "#f0e1e4", ink: "#2a1a1e", muted: "#6f545a", faint: "#b0979c", line: "#ecdade", accent: "#9c3456", onAccent: "#ffffff", mark: "#f8dc9c", string: "#8c4a1d", ok: "#357149", warn: "#935809", bad: "#b03535", warnBg: "#fbeedd" },
  },
  {
    id: "sky",
    name: "Sky",
    dark: false,
    colors: { bg: "#f6f9fc", panel: "#ebf1f8", panel2: "#dfe8f2", ink: "#142033", muted: "#4f5e72", faint: "#93a2b5", line: "#dbe4ee", accent: "#1a64a8", onAccent: "#ffffff", mark: "#fbe39a", string: "#8a5520", ok: "#2a7350", warn: "#8d5a0a", bad: "#b53636", warnBg: "#fbf1dd" },
  },
  {
    id: "lavender",
    name: "Lavender",
    dark: false,
    colors: { bg: "#f9f7fc", panel: "#f0ecf7", panel2: "#e6e0f2", ink: "#211c2e", muted: "#5d556f", faint: "#a29bb5", line: "#e4ddf0", accent: "#5c3cb0", onAccent: "#ffffff", mark: "#f6e09a", string: "#87531f", ok: "#33704c", warn: "#8d5b0b", bad: "#b03848", warnBg: "#f8eedb" },
  },
  {
    id: "contrast-light",
    name: "High contrast",
    dark: false,
    colors: { bg: "#ffffff", panel: "#f2f2f2", panel2: "#e3e3e3", ink: "#000000", muted: "#333333", faint: "#6b6b6b", line: "#8a8a8a", accent: "#0040c0", onAccent: "#ffffff", mark: "#ffe14d", string: "#7a3a00", ok: "#00662b", warn: "#7a4200", bad: "#a8001e", warnBg: "#fff1c2" },
  },
  // --- dark ----------------------------------------------------------------
  {
    id: "ink",
    name: "Ink",
    dark: true,
    colors: { bg: "#191817", panel: "#201e1c", panel2: "#2a2725", ink: "#e9e5dd", muted: "#a8a196", faint: "#6f695f", line: "#2f2c29", accent: "#7fb8b4", onAccent: "#10201f", mark: "#6b5a1e", string: "#d8a866", ok: "#6cbf8b", warn: "#e0a84a", bad: "#e8807a", warnBg: "#3a2f1a" },
  },
  {
    id: "midnight",
    name: "Midnight",
    dark: true,
    colors: { bg: "#0f1626", panel: "#141d31", panel2: "#1b263e", ink: "#e3e9f5", muted: "#9aa8c2", faint: "#5e6b85", line: "#233049", accent: "#7aa7ff", onAccent: "#0b1430", mark: "#5a4a14", string: "#e7b46a", ok: "#6fcf97", warn: "#f0b45a", bad: "#ff8585", warnBg: "#33291a" },
  },
  {
    id: "forest",
    name: "Forest",
    dark: true,
    colors: { bg: "#121a15", panel: "#17211b", panel2: "#1f2b23", ink: "#e1ebe2", muted: "#9db3a2", faint: "#5f7465", line: "#26342b", accent: "#8fd19e", onAccent: "#0d2414", mark: "#4f5a1c", string: "#e3c07a", ok: "#7fd99a", warn: "#e6b45c", bad: "#f08a7d", warnBg: "#2f2d18" },
  },
  {
    id: "mocha",
    name: "Mocha",
    dark: true,
    colors: { bg: "#1e1814", panel: "#261f1a", panel2: "#2f2620", ink: "#f0e6dc", muted: "#bba795", faint: "#7d6b5c", line: "#3a2f27", accent: "#e0a96d", onAccent: "#2a1a0a", mark: "#6a4f1a", string: "#d9b27c", ok: "#9ccf8a", warn: "#f0b860", bad: "#ef8a76", warnBg: "#3d2f1a" },
  },
  {
    id: "plum",
    name: "Plum",
    dark: true,
    colors: { bg: "#1b1520", panel: "#221a29", panel2: "#2b2133", ink: "#ece3f3", muted: "#b3a2c2", faint: "#75667f", line: "#35293f", accent: "#d39cff", onAccent: "#25103a", mark: "#5b3e5e", string: "#e6b87a", ok: "#8fd3a5", warn: "#f0bb63", bad: "#ff8aa0", warnBg: "#352819" },
  },
  {
    id: "graphite",
    name: "Graphite",
    dark: true,
    colors: { bg: "#1c1d1f", panel: "#232427", panel2: "#2b2d30", ink: "#e8e8e6", muted: "#a6a7a8", faint: "#696b6e", line: "#35373b", accent: "#ff9e57", onAccent: "#2b1505", mark: "#6b5418", string: "#e2c07e", ok: "#7fcf93", warn: "#f2b552", bad: "#ff8478", warnBg: "#382e1c" },
  },
  {
    id: "fjord",
    name: "Fjord",
    dark: true,
    colors: { bg: "#232a36", panel: "#29313f", panel2: "#303a4a", ink: "#edf1f6", muted: "#adb8c8", faint: "#6d7a8d", line: "#3a4556", accent: "#86c3d6", onAccent: "#10242c", mark: "#5b5232", string: "#e8c88a", ok: "#a3d39c", warn: "#ebb974", bad: "#ec8e95", warnBg: "#3a3426" },
  },
  {
    id: "contrast-dark",
    name: "High contrast dark",
    dark: true,
    colors: { bg: "#000000", panel: "#0d0d0d", panel2: "#1a1a1a", ink: "#ffffff", muted: "#d0d0d0", faint: "#9a9a9a", line: "#8a8a8a", accent: "#6cb6ff", onAccent: "#000000", mark: "#6b5600", string: "#ffcc66", ok: "#5ee38a", warn: "#ffc14d", bad: "#ff6b6b", warnBg: "#3a2c00" },
  },
  // --- added 28 Nov: pastels (Mint, Peach, Lilac, Butter, Powder, Blush) and more; generated to pass the contrast rules ---
  {
    id: "mint",
    name: "Mint",
    dark: false,
    colors: { bg: "#edfaf4", panel: "#dcf6e9", panel2: "#ccf2df", ink: "#12211a", muted: "#586f63", faint: "#9aaca3", line: "#c4ebd7", accent: "#15755d", onAccent: "#ffffff", mark: "#f7e497", string: "#8b4e18", ok: "#206f3a", warn: "#915608", bad: "#b12f25", warnBg: "#fcf0d9" },
  },
  {
    id: "peach",
    name: "Peach",
    dark: false,
    colors: { bg: "#fdf1ea", panel: "#fee4d5", panel2: "#fdd7c1", ink: "#211712", muted: "#72635a", faint: "#aca19a", line: "#f6cfb9", accent: "#a03b22", onAccent: "#ffffff", mark: "#f7e497", string: "#8b5218", ok: "#206f3a", warn: "#915608", bad: "#b12f25", warnBg: "#fcf0d9" },
  },
  {
    id: "lilac",
    name: "Lilac",
    dark: false,
    colors: { bg: "#f5f1fb", panel: "#eadff8", panel2: "#decef5", ink: "#181221", muted: "#645a72", faint: "#a29aac", line: "#d7c6ee", accent: "#5e3091", onAccent: "#ffffff", mark: "#f7e497", string: "#8b4818", ok: "#206f3a", warn: "#915608", bad: "#b12f25", warnBg: "#fcf0d9" },
  },
  {
    id: "butter",
    name: "Butter",
    dark: false,
    colors: { bg: "#fdf9e5", panel: "#fdf6d0", panel2: "#fdf2bc", ink: "#211f12", muted: "#726e5a", faint: "#aca99a", line: "#f5eab5", accent: "#1d6ca5", onAccent: "#ffffff", mark: "#f7e497", string: "#8b4218", ok: "#206f3a", warn: "#915608", bad: "#b12f25", warnBg: "#fcf0d9" },
  },
  {
    id: "powder",
    name: "Powder",
    dark: false,
    colors: { bg: "#edf5fc", panel: "#daebfb", panel2: "#c7e0fa", ink: "#121a21", muted: "#5a6672", faint: "#9aa3ac", line: "#bfd9f3", accent: "#1d56a5", onAccent: "#ffffff", mark: "#f7e497", string: "#8b4818", ok: "#206f3a", warn: "#915608", bad: "#b12f25", warnBg: "#fcf0d9" },
  },
  {
    id: "blush",
    name: "Blush",
    dark: false,
    colors: { bg: "#fcf0f3", panel: "#fbdde5", panel2: "#f8cbd6", ink: "#211216", muted: "#725a60", faint: "#ac9a9f", line: "#f1c3ce", accent: "#962c4f", onAccent: "#ffffff", mark: "#f7e497", string: "#8b4818", ok: "#206f3a", warn: "#915608", bad: "#b12f25", warnBg: "#fcf0d9" },
  },
  {
    id: "linen",
    name: "Linen",
    dark: false,
    colors: { bg: "#f8f5f2", panel: "#f2ede6", panel2: "#ece4da", ink: "#211b12", muted: "#6f6558", faint: "#aca59a", line: "#e3dace", accent: "#25707e", onAccent: "#ffffff", mark: "#f7e497", string: "#8b4e18", ok: "#206f3a", warn: "#915608", bad: "#b12f25", warnBg: "#fcf0d9" },
  },
  {
    id: "slate-light",
    name: "Slate",
    dark: false,
    colors: { bg: "#f1f3f6", panel: "#e7eaef", panel2: "#dce1e7", ink: "#121821", muted: "#5a6472", faint: "#9aa2ac", line: "#d1d6de", accent: "#2c4696", onAccent: "#ffffff", mark: "#f7e497", string: "#8b4818", ok: "#206f3a", warn: "#915608", bad: "#b12f25", warnBg: "#fcf0d9" },
  },
  {
    id: "dusk",
    name: "Dusk",
    dark: true,
    colors: { bg: "#1e1a28", panel: "#231f30", panel2: "#2b2639", ink: "#ebe9f2", muted: "#a29cb4", faint: "#615c70", line: "#322d40", accent: "#bea1f7", onAccent: "#160e25", mark: "#5c501f", string: "#e4bb81", ok: "#79d297", warn: "#edaf5e", bad: "#f4837b", warnBg: "#362a17" },
  },
  {
    id: "aurora",
    name: "Aurora",
    dark: true,
    colors: { bg: "#142224", panel: "#19292c", panel2: "#1f3235", ink: "#e9f0f2", muted: "#9cb0b4", faint: "#5c6d70", line: "#263a3e", accent: "#a8f0d2", onAccent: "#0e251b", mark: "#5c501f", string: "#e4c381", ok: "#79d297", warn: "#edaf5e", bad: "#f4837b", warnBg: "#362a17" },
  },
  {
    id: "candy",
    name: "Candy",
    dark: true,
    colors: { bg: "#241920", panel: "#2b1f26", panel2: "#34252e", ink: "#f2e9ee", muted: "#b49caa", faint: "#705c68", line: "#3c2d36", accent: "#f7a1c5", onAccent: "#250e18", mark: "#5c501f", string: "#e4c381", ok: "#79d297", warn: "#edaf5e", bad: "#f4837b", warnBg: "#362a17" },
  },
  {
    id: "ocean",
    name: "Ocean",
    dark: true,
    colors: { bg: "#0d1d2b", panel: "#102434", panel2: "#152b3f", ink: "#e9edf2", muted: "#9ca9b4", faint: "#5c6770", line: "#1c3348", accent: "#75d1f0", onAccent: "#0e1f25", mark: "#5c501f", string: "#e4c081", ok: "#79d297", warn: "#edaf5e", bad: "#f4837b", warnBg: "#362a17" },
  },
  {
    id: "ember",
    name: "Ember",
    dark: true,
    colors: { bg: "#1f1714", panel: "#261d1a", panel2: "#2f2420", ink: "#f2ebe9", muted: "#b4a29c", faint: "#70615c", line: "#372b28", accent: "#f7a06e", onAccent: "#25160e", mark: "#5c501f", string: "#e4cb81", ok: "#79d297", warn: "#edaf5e", bad: "#f4837b", warnBg: "#362a17" },
  },
  {
    id: "pine",
    name: "Pine",
    dark: true,
    colors: { bg: "#111d19", panel: "#162420", panel2: "#1d2d28", ink: "#e9f2ef", muted: "#9cb4ac", faint: "#5c7069", line: "#243630", accent: "#88dda4", onAccent: "#0e2516", mark: "#5c501f", string: "#e4c681", ok: "#79d297", warn: "#edaf5e", bad: "#f4837b", warnBg: "#362a17" },
  },
  {
    id: "charcoal",
    name: "Charcoal",
    dark: true,
    colors: { bg: "#1c1c1c", panel: "#222222", panel2: "#2a2a2a", ink: "#f2e9e9", muted: "#b49c9c", faint: "#705c5c", line: "#323232", accent: "#f4d371", onAccent: "#251f0e", mark: "#5c501f", string: "#e4b381", ok: "#79d297", warn: "#edaf5e", bad: "#f4837b", warnBg: "#362a17" },
  },
  {
    id: "mulberry",
    name: "Mulberry",
    dark: true,
    colors: { bg: "#201320", panel: "#271827", panel2: "#301f30", ink: "#f2e9f2", muted: "#b49cb4", faint: "#705c70", line: "#392639", accent: "#d985e0", onAccent: "#230e25", mark: "#5c501f", string: "#e4c081", ok: "#79d297", warn: "#edaf5e", bad: "#f4837b", warnBg: "#362a17" },
  },
];

/** "System" follows the OS: Paper by day, Ink by night. */
export const SYSTEM_THEME = "system";
export const LIGHT_DEFAULT = "paper";
export const DARK_DEFAULT = "ink";

export function themeById(id: string): Theme | undefined {
  return THEMES.find((t) => t.id === id);
}

// --- contrast (WCAG 2) --------------------------------------------------------

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// --- colour helpers (generating themes, the colour-blind option) ---------------

export function hexToHsl(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s * 100, l * 100];
}

export function hslToHex(h: number, s: number, l: number): string {
  const S = Math.max(0, Math.min(100, s)) / 100;
  const L = Math.max(0, Math.min(100, l)) / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = S * Math.min(L, 1 - L);
  const f = (n: number) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return "#" + [f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("");
}

/**
 * The colour with hue h and saturation s, lightness moved from `l` (darker on
 * a light theme, lighter on a dark one) until it has at least `min` contrast
 * with every background in `against`.
 */
export function fit(h: number, s: number, l: number, against: string[], min: number, dark: boolean): string {
  for (let L = l; L >= 0 && L <= 100; L += dark ? 1 : -1) {
    const hex = hslToHex(h, s, L);
    if (against.every((bg) => contrast(hex, bg) >= min)) return hex;
  }
  return dark ? "#ffffff" : "#000000";
}

/**
 * Colour-blind option: status colours that don't rely on telling red from
 * green (Okabe–Ito hues): blue for "ok", vermillion for "problem", reddish
 * purple for "warning", each fitted to the theme for contrast.
 */
export function colorblindColors(t: Theme): Pick<ThemeColors, "ok" | "bad" | "warn"> {
  const c = t.colors;
  const bgs = [c.bg, c.panel];
  return {
    ok: fit(205, t.dark ? 85 : 100, t.dark ? 62 : 35, bgs, 4.6, t.dark),
    bad: fit(24, t.dark ? 95 : 100, t.dark ? 62 : 42, bgs, 4.6, t.dark),
    warn: fit(320, t.dark ? 55 : 50, t.dark ? 70 : 45, [...bgs, c.warnBg], 4.6, t.dark),
  };
}
