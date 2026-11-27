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
