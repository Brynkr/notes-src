// Top bar (go-to-note, text zoom, Appearance button) and the Appearance
// pop-out panel: themes first, then fonts, text, layout and editor options.
// Every change applies immediately and is remembered on this device.

import { FONTS, type Appearance, type AppearanceStore, type EditorFont } from "../appearance/prefs.ts";
import { SYSTEM_THEME, THEMES, type Theme } from "../appearance/themes.ts";
import { h, icons, isMac, modKey } from "./dom.ts";

const ZOOM_STEP = 0.1;

export class TopBar {
  readonly el: HTMLElement;
  private readonly zoomLabel: HTMLButtonElement;
  readonly panel: AppearancePanel;
  private readonly appearanceBtn: HTMLButtonElement;
  private readonly store: AppearanceStore;

  constructor(store: AppearanceStore, opts: { goto: () => void }) {
    this.store = store;
    this.panel = new AppearancePanel(store, () => this.appearanceBtn.focus());
    this.zoomLabel = h("button", {
      class: "zoom-value",
      title: `Text size: click to reset (${modKey}+0)`,
      "aria-label": "Reset text size",
      onclick: () => store.set({ zoom: 1 }),
    });
    this.appearanceBtn = h("button", {
      class: "icon-btn appearance-btn",
      title: "Appearance: themes, fonts, layout",
      "aria-label": "Appearance",
      "aria-haspopup": "dialog",
      "aria-expanded": "false",
      html: icons.palette,
      onclick: () => this.panel.toggle(),
    });
    this.el = h(
      "header",
      { class: "topbar" },
      h(
        "button",
        { class: "goto", title: `Go to a note (${modKey}+P)`, onclick: () => opts.goto() },
        h("span", { class: "goto-icon", html: icons.search }),
        h("span", { class: "goto-text" }, "Go to note…"),
        h("kbd", {}, `${isMac ? "⌘" : "Ctrl+"}P`),
      ),
      h("span", { class: "spacer" }),
      h(
        "div",
        { class: "zoom", role: "group", "aria-label": "Text size" },
        h("button", { class: "icon-btn", title: `Smaller text (${modKey}+−)`, "aria-label": "Smaller text", html: icons.minus, onclick: () => store.zoomBy(-ZOOM_STEP) }),
        this.zoomLabel,
        h("button", { class: "icon-btn", title: `Larger text (${modKey}++)`, "aria-label": "Larger text", html: icons.plus, onclick: () => store.zoomBy(ZOOM_STEP) }),
      ),
      h("div", { class: "appearance-anchor" }, this.appearanceBtn, this.panel.el),
    );
    this.panel.onToggle = (open) => this.appearanceBtn.setAttribute("aria-expanded", String(open));
    store.onChange(() => this.render());
    this.render();
  }

  private render(): void {
    this.zoomLabel.textContent = `${Math.round(this.store.value.zoom * 100)}%`;
  }
}

type Choice<T extends string> = { value: T; label: string };

export class AppearancePanel {
  readonly el: HTMLElement;
  private readonly store: AppearanceStore;
  private readonly returnFocus: () => void;
  onToggle: (open: boolean) => void = () => undefined;

  constructor(store: AppearanceStore, returnFocus: () => void) {
    this.store = store;
    this.returnFocus = returnFocus;
    this.el = h("div", {
      class: "appearance-panel",
      role: "dialog",
      "aria-label": "Appearance",
      hidden: true,
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          this.close();
        }
      },
    });
    store.onChange(() => {
      if (this.isOpen) this.render();
    });
    // Close when clicking anywhere else.
    document.addEventListener("mousedown", (e) => {
      if (!this.isOpen) return;
      const t = e.target as Node;
      if (!this.el.contains(t) && !(t as HTMLElement).closest?.(".appearance-btn")) this.close(false);
    });
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  open(): void {
    this.el.hidden = false;
    this.render();
    this.onToggle(true);
    this.el.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus();
  }

  close(restoreFocus = true): void {
    if (!this.isOpen) return;
    this.el.hidden = true;
    this.onToggle(false);
    if (restoreFocus) this.returnFocus();
  }

  private render(): void {
    const a = this.store.value;
    const scroll = this.el.scrollTop;
    this.el.replaceChildren(
      h("div", { class: "ap-head" }, h("h2", {}, "Appearance"), h("button", { class: "icon-btn", "aria-label": "Close", html: icons.close, onclick: () => this.close() })),
      this.section(
        "Theme",
        h(
          "button",
          {
            class: "ap-auto",
            "aria-pressed": String(a.theme === SYSTEM_THEME),
            onclick: () => this.store.set({ theme: SYSTEM_THEME }),
          },
          h("span", { class: "ap-auto-swatch" }, swatch(THEMES[0]), swatch(THEMES[8])),
          h("span", {}, h("strong", {}, "Automatic"), h("small", {}, "Paper by day, Ink at night, following your system")),
        ),
        h("div", { class: "ap-subhead" }, "Light"),
        this.themeGrid(THEMES.filter((t) => !t.dark), a.theme),
        h("div", { class: "ap-subhead" }, "Dark"),
        this.themeGrid(THEMES.filter((t) => t.dark), a.theme),
      ),
      this.section(
        "Font",
        h(
          "div",
          { class: "ap-fonts", role: "radiogroup", "aria-label": "Note font" },
          ...(Object.keys(FONTS) as EditorFont[]).map((f) =>
            h(
              "button",
              {
                class: "ap-font",
                role: "radio",
                "aria-checked": String(a.editorFont === f),
                "aria-pressed": String(a.editorFont === f),
                style: `font-family: ${FONTS[f].stack}`,
                onclick: () => this.store.set({ editorFont: f }),
              },
              h("span", { class: "ap-font-sample" }, "Aa"),
              h("span", { class: "ap-font-name" }, FONTS[f].name),
            ),
          ),
        ),
        this.segmented("Interface", a.uiFont, [
          { value: "system", label: "System font" },
          { value: "editor", label: "Same as notes" },
        ], (v) => this.store.set({ uiFont: v })),
      ),
      this.section(
        "Text",
        this.segmented("Line spacing", a.lineHeight, [
          { value: "compact", label: "Tight" },
          { value: "normal", label: "Normal" },
          { value: "relaxed", label: "Airy" },
        ], (v) => this.store.set({ lineHeight: v })),
        this.segmented("Line width", a.width, [
          { value: "narrow", label: "Narrow" },
          { value: "normal", label: "Normal" },
          { value: "wide", label: "Wide" },
          { value: "full", label: "Full" },
        ], (v) => this.store.set({ width: v })),
        h(
          "div",
          { class: "ap-row" },
          h("span", { class: "ap-label" }, "Text size"),
          h(
            "div",
            { class: "ap-zoom" },
            h("button", { class: "btn btn-small", onclick: () => this.store.zoomBy(-0.1) }, "−"),
            h("span", { class: "ap-zoom-value" }, `${Math.round(a.zoom * 100)}%`),
            h("button", { class: "btn btn-small", onclick: () => this.store.zoomBy(0.1) }, "+"),
          ),
        ),
      ),
      this.section(
        "Layout",
        this.segmented("Borders", a.borders, [
          { value: "none", label: "None" },
          { value: "subtle", label: "Subtle" },
          { value: "strong", label: "Strong" },
          { value: "cards", label: "Cards" },
        ], (v) => this.store.set({ borders: v })),
        this.segmented("Corners", a.corners, [
          { value: "square", label: "Square" },
          { value: "soft", label: "Soft" },
          { value: "round", label: "Round" },
        ], (v) => this.store.set({ corners: v })),
        this.segmented("Spacing", a.density, [
          { value: "compact", label: "Compact" },
          { value: "comfortable", label: "Comfortable" },
          { value: "spacious", label: "Spacious" },
        ], (v) => this.store.set({ density: v })),
      ),
      this.section(
        "Editor",
        this.switchRow("Line numbers", a.lineNumbers, (v) => this.store.set({ lineNumbers: v })),
        this.switchRow("Highlight the current line", a.activeLine, (v) => this.store.set({ activeLine: v })),
        this.switchRow("Spell check", a.spellcheck, (v) => this.store.set({ spellcheck: v })),
        this.switchRow("Animations", a.motion, (v) => this.store.set({ motion: v })),
      ),
      h(
        "div",
        { class: "ap-foot" },
        h("span", {}, "Saved on this device"),
        h("button", { class: "btn btn-small", onclick: () => this.store.reset() }, "Reset to defaults"),
      ),
    );
    this.el.scrollTop = scroll;
  }

  private section(title: string, ...children: Node[]): HTMLElement {
    return h("section", { class: "ap-section", "aria-label": title }, h("h3", {}, title), ...children);
  }

  private themeGrid(themes: Theme[], current: string): HTMLElement {
    return h(
      "div",
      { class: "ap-themes" },
      ...themes.map((t) =>
        h(
          "button",
          {
            class: "ap-theme",
            "aria-pressed": String(current === t.id),
            title: t.name,
            "data-theme-id": t.id,
            onclick: () => this.store.set({ theme: t.id }),
          },
          swatch(t),
          h("span", { class: "ap-theme-name" }, t.name),
        ),
      ),
    );
  }

  private segmented<T extends string>(label: string, value: T, choices: Choice<T>[], set: (v: T) => void): HTMLElement {
    return h(
      "div",
      { class: "ap-row" },
      h("span", { class: "ap-label" }, label),
      h(
        "div",
        { class: "segmented", role: "radiogroup", "aria-label": label },
        ...choices.map((c) =>
          h("button", { role: "radio", "aria-checked": String(c.value === value), "aria-pressed": String(c.value === value), onclick: () => set(c.value) }, c.label),
        ),
      ),
    );
  }

  private switchRow(label: string, on: boolean, set: (v: boolean) => void): HTMLElement {
    const box = h("input", { type: "checkbox", class: "check", onchange: () => set(box.checked) }) as HTMLInputElement;
    box.checked = on;
    return h("label", { class: "ap-toggle" }, box, label);
  }
}

/** A tiny picture of a theme: page, sidebar, text lines and accent. */
function swatch(t: Theme): HTMLElement {
  const c = t.colors;
  return h(
    "span",
    { class: "swatch", style: `background:${c.bg};border-color:${c.line}` },
    h("span", { class: "swatch-side", style: `background:${c.panel}` }),
    h("span", { class: "swatch-line", style: `background:${c.ink};width:58%` }),
    h("span", { class: "swatch-line", style: `background:${c.muted};width:72%;opacity:.7` }),
    h("span", { class: "swatch-dot", style: `background:${c.accent}` }),
  );
}
