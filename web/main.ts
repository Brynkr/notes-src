// Web UI entry point. Wires sidebar, panes, status bar and server events.

import type { NoteMeta, SyncStatusDto } from "../shared/types.ts";
import { linkKey, resolveLink } from "../shared/links.ts";
import { inMode, MODE_FOLDER, MODE_LABEL, modeFolderOf } from "../shared/modes.ts";
import { ModeStore } from "./state/mode.ts";
import { IdeStore } from "./state/ide.ts";
import { Explorer } from "./ui/explorer.ts";
import { DiffDialog } from "./ui/diffview.ts";
import { api, ApiError, subscribe } from "./api.ts";
import { BufferStore } from "./state/buffers.ts";
import { Workspace } from "./state/workspace.ts";
import { h, icons, isMac, toast } from "./ui/dom.ts";
import { PaneGrid } from "./ui/panes.ts";
import { Sidebar } from "./ui/sidebar.ts";
import { ConflictBanner, originalOf, StatusBar } from "./ui/statusbar.ts";
import { QuickSwitcher } from "./ui/switcher.ts";
import { TrashDialog } from "./ui/trash.ts";
import { HistoryDialog } from "./ui/history.ts";
import { AppearanceStore } from "./appearance/prefs.ts";
import { TopBar } from "./ui/appearance.ts";

// Apply the saved look before anything renders (setup screen included).
const appearance = new AppearanceStore();
appearance.apply();
import { renderSetup, SettingsDialog } from "./ui/settings.ts";

const workspace = new Workspace();
const buffers = new BufferStore();
const mode = new ModeStore();
const ide = new IdeStore();
/** Every note, both modes (links and conflict copies can cross modes). */
let notes: NoteMeta[] = [];
/** IDE mode: notes and code files of the current mode, by path. */
let files: NoteMeta[] = [];
/** The notes of the current mode: what the sidebar, switcher and daily note use. */
function modeNotes(): NoteMeta[] {
  return notes.filter((n) => inMode(n.path, mode.value));
}
let status: SyncStatusDto | null = null;

// --- actions -----------------------------------------------------------------

async function createNote(title: string, toSide = false): Promise<void> {
  try {
    const note = await api.create(title, mode.value);
    buffers.adopt(note.path, note.text, note.hash);
    // Cursor after the "# Title" line, ready to type.
    if (toSide) workspace.openToSide(note.path, note.text.length);
    else workspace.open(note.path, undefined, note.text.length);
    await refreshNotes();
    if (isNarrow()) setSidebarOpen(false);
    grid.focusActive();
  } catch (err) {
    toast(`Couldn't create the note: ${(err as Error).message}`, "error");
  }
}

/** IDE mode: make an empty file (path inside the current mode's folder) and open it. */
async function createFile(rel: string): Promise<void> {
  // Windows-style separators become "/"; leading slashes are dropped.
  const clean = rel.split(String.fromCharCode(92)).join("/").replace(/^\/+/, "");
  if (!clean) return;
  const path = `${MODE_FOLDER[mode.value]}/${clean}`;
  try {
    const file = await api.createFile(path);
    buffers.adopt(file.path, file.text, file.hash);
    workspace.open(file.path);
    await refreshNotes();
    grid.focusActive();
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      openNote(path, false); // already there: just open it
      return;
    }
    toast(`Couldn't create the file: ${(err as Error).message}`, "error");
  }
}

/** Move a note to the Trash, with an Undo button. */
async function deleteNote(path: string): Promise<void> {
  const title = notes.find((n) => n.path === path)?.title ?? path;
  // Save any last keystrokes, then close it here first so the server's
  // "deleted" event isn't reported as a remote change.
  const b = buffers.get(path);
  if (b) await buffers.flush(b);
  buffers.forget(path);
  workspace.noteGone(path);
  try {
    const { trashPath } = await api.remove(path);
    await refreshNotes();
    toast(`Moved “${title}” to the Trash.`, "info", [
      {
        label: "Undo",
        run: async () => {
          try {
            const { path: restored } = await api.restoreTrash(trashPath);
            await refreshNotes();
            openNote(restored, false);
          } catch (err) {
            toast(`Couldn't undo: ${(err as Error).message}`, "error");
          }
        },
      },
    ], 10_000);
  } catch (err) {
    toast(`Couldn't delete: ${(err as Error).message}`, "error");
  }
}

function openNote(path: string, toSide: boolean): void {
  if (toSide) workspace.openToSide(path);
  else workspace.open(path);
  if (isNarrow()) setSidebarOpen(false);
  requestAnimationFrame(() => grid.focusActive());
}

/** Open a conflict copy next to its original so they can be compared. */
function compareConflict(copy: string): void {
  const original = originalOf(copy);
  if (notes.some((n) => n.path === original)) {
    workspace.open(original);
    workspace.openToSide(copy);
  } else {
    workspace.open(copy);
  }
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshing: Promise<void> | null = null;
function refreshNotesSoon(): void {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshNotes();
  }, 200);
}
async function refreshNotes(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      notes = await api.list();
      if (ide.value) {
        files = await api.files(mode.value);
        explorer.setFiles(files);
      }
      rebuildLinkKeys();
      sidebar.setNotes(modeNotes());
      grid.notesChanged();
      sidebar.setActivePath(workspace.active.notePath);
      explorer.setActivePath(workspace.active.notePath);
    } catch {
      /* server down: status bar already says so */
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

function setStatus(s: SyncStatusDto): void {
  status = s;
  statusbar.setStatus(s);
  banner.set(s.conflicts);
}

async function syncNow(): Promise<void> {
  await buffers.flushAll();
  try {
    setStatus(await api.sync());
  } catch (err) {
    toast(`Sync failed: ${(err as Error).message}`, "error");
  }
}

// --- layout ------------------------------------------------------------------

const explorer = new Explorer({
  mode: () => mode.value,
  open: (path, toSide) => openNote(path, toSide),
  showDiff: (req) => void diffDialog.show(req),
});

const sidebar = new Sidebar({
  showTrash: () => void trashDialog.show(),
  today: openDailyNote,
  open: openNote,
  create: createNote,
  collapse: () => setSidebarOpen(false),
  mode: () => mode.value,
  setMode: (m) => mode.set(m),
  createFile,
  explorer: explorer.el,
});
mode.onChange(() => {
  sidebar.modeChanged();
  sidebar.setNotes(modeNotes());
  if (ide.value) {
    void refreshNotes();
    if (explorer.showingChanges) void explorer.refreshChanges();
  }
});
/** IDE mode on/off: file tree and changes in the sidebar, "Go to" includes code files. */
function applyIde(): void {
  document.documentElement.dataset.ide = ide.value ? "on" : "off";
  sidebar.setIde(ide.value);
  explorer.setActivePath(workspace.active.notePath);
  if (ide.value) void refreshNotes();
}
ide.onChange(() => applyIde());
sidebar.modeChanged();

/** Today's note, titled YYYY-MM-DD (local date): open it, or create it. */
function openDailyNote(): void {
  const d = new Date();
  const title = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const hit = modeNotes().find((n) => n.title === title && !n.conflict);
  if (hit) openNote(hit.path, false);
  else void createNote(title);
}

/** Follow a wiki link: open the note, or create it if it doesn't exist yet. */
function followLink(target: string, toSide: boolean): void {
  // Same mode first, so Home and Work can each have a note called "Ideas".
  const hit = resolveLink(target, modeNotes()) ?? resolveLink(target, notes);
  if (hit) openNote(hit.path, toSide);
  else void createNote(target, toSide);
}

let linkKeys = new Set<string>();
function rebuildLinkKeys(): void {
  linkKeys = new Set();
  for (const n of notes) {
    linkKeys.add(linkKey(n.title));
    const base = n.path.slice(n.path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
    linkKeys.add(linkKey(base));
    linkKeys.add(linkKey(base.replace(/^\d{8}-\d{6}-/, "")));
    linkKeys.add(linkKey(n.path));
  }
}

const grid = new PaneGrid({
  workspace,
  buffers,
  deleteNote,
  openNote,
  showHistory: (target) => void historyDialog.show(target),
  editorPrefs: () => ({ lineNumbers: appearance.value.lineNumbers, activeLine: appearance.value.activeLine, spellcheck: appearance.value.spellcheck }),
  links: {
    notes: () => notes,
    exists: (target) => linkKeys.has(linkKey(target)),
    follow: followLink,
  },
  newNote: () => showNewNote(),
  extraKeys: () => [
    {
      key: "Mod-s",
      run: () => {
        saveAll();
        return true;
      },
    },
  ],
});

const switcher = new QuickSwitcher({
  notes: () => (ide.value ? files : modeNotes()),
  open: openNote,
  create: (title, toSide) => void createNote(title, toSide),
  cancel: () => grid.focusActive(),
});

const historyDialog = new HistoryDialog({ onClosed: () => grid.focusActive() });

const trashDialog = new TrashDialog({
  onRestored: (path) => void refreshNotes().then(() => openNote(path, false)),
  onClosed: () => grid.focusActive(),
  mode: () => mode.value,
});

const settingsDialog = new SettingsDialog({
  onClosed: () => grid.focusActive(),
  beforeApply: () => buffers.flushAll(),
});

const statusbar = new StatusBar({ syncNow: () => void syncNow(), setLayout: (l) => workspace.setLayout(l) });
const banner = new ConflictBanner(compareConflict, (path) => notes.find((n) => n.path === path)?.title);
const sidebarToggle = h("button", {
  class: "icon-btn sidebar-toggle",
  title: "Show or hide the note list",
  "aria-label": "Toggle sidebar",
  html: icons.sidebar,
  onclick: () => setSidebarOpen(!sidebarOpen()),
});
statusbar.el.prepend(sidebarToggle);
statusbar.el.append(
  h("button", { class: "icon-btn", title: `Settings (${isMac ? "⌘" : "Ctrl"}+,)`, "aria-label": "Settings", html: icons.gear, onclick: () => void settingsDialog.show() }),
);

const resizer = h("div", { class: "resizer", role: "separator", "aria-orientation": "vertical", title: "Drag to resize" });
const scrim = h("div", { class: "scrim", onclick: () => setSidebarOpen(false) });
const topbar = new TopBar(appearance, { goto: () => switcher.show(), ide });
const diffDialog = new DiffDialog({ open: (path) => openNote(path, false), onClosed: () => grid.focusActive() });
appearance.onChange((a, changed) => {
  if (changed.some((k) => k === "lineNumbers" || k === "activeLine" || k === "spellcheck")) {
    grid.applyEditorPrefs({ lineNumbers: a.lineNumbers, activeLine: a.activeLine, spellcheck: a.spellcheck });
  }
  // Fonts and sizes change line heights: let the editors re-measure.
  requestAnimationFrame(() => grid.remeasure());
});
const main = h("main", { class: "main" }, topbar.el, banner.el, grid.el, statusbar.el);
const root = h("div", { class: "app" }, sidebar.el, resizer, scrim, main, switcher.el, settingsDialog.el, trashDialog.el, historyDialog.el, diffDialog.el);

function showNewNote(): void {
  setSidebarOpen(true);
  sidebar.showNew();
}

const narrowQuery = matchMedia("(max-width: 760px)");
function isNarrow(): boolean {
  return narrowQuery.matches;
}

/** On phones the sidebar is an overlay with its own, unpersisted open state. */
let narrowSidebarOpen = false;
function setSidebarOpen(open: boolean): void {
  if (isNarrow()) {
    narrowSidebarOpen = open;
    applyChrome();
  } else {
    workspace.setSidebar({ sidebarCollapsed: !open });
  }
}
function sidebarOpen(): boolean {
  return isNarrow() ? narrowSidebarOpen : !workspace.state.sidebarCollapsed;
}

function applyChrome(): void {
  const s = workspace.state;
  root.style.setProperty("--sidebar-w", `${s.sidebarWidth}px`);
  root.classList.toggle("sidebar-collapsed", isNarrow() ? !narrowSidebarOpen : s.sidebarCollapsed);
  root.classList.toggle("narrow", isNarrow());
  statusbar.setLayout(s.layout);
}
narrowQuery.addEventListener("change", () => {
  narrowSidebarOpen = !workspace.active.notePath;
  applyChrome();
});

workspace.onChange((s, structural) => {
  applyChrome();
  if (structural) {
    grid.render();
    sidebar.setActivePath(workspace.active.notePath);
    explorer.setActivePath(workspace.active.notePath);
  }
});

// Drag to resize the sidebar.
resizer.addEventListener("pointerdown", (e) => {
  resizer.setPointerCapture(e.pointerId);
  root.classList.add("resizing");
  const move = (ev: PointerEvent) => {
    root.style.setProperty("--sidebar-w", `${Math.min(600, Math.max(180, ev.clientX))}px`);
  };
  const up = (ev: PointerEvent) => {
    resizer.removeEventListener("pointermove", move);
    root.classList.remove("resizing");
    workspace.setSidebar({ sidebarWidth: Math.min(600, Math.max(180, ev.clientX)) });
  };
  resizer.addEventListener("pointermove", move);
  resizer.addEventListener("pointerup", up, { once: true });
});

// --- keyboard ----------------------------------------------------------------

window.addEventListener(
  "keydown",
  (e) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (e.key === "Escape" && topbar.panel.isOpen) {
      e.preventDefault();
      topbar.panel.close();
      return;
    }
    if (mod && !e.altKey && (e.key === "=" || e.key === "+")) {
      e.preventDefault(); // text zoom instead of page zoom
      appearance.zoomBy(0.1);
      return;
    }
    if (mod && !e.altKey && (e.key === "-" || e.key === "_")) {
      e.preventDefault();
      appearance.zoomBy(-0.1);
      return;
    }
    if (mod && !e.altKey && e.key === "0") {
      e.preventDefault();
      appearance.set({ zoom: 1 });
      return;
    }
    if (e.key === "Escape") {
      // Close whichever dialog is open, wherever the focus is.
      for (const d of [historyDialog, trashDialog, settingsDialog, diffDialog]) {
        if (d.isOpen) {
          e.preventDefault();
          d.close();
          return;
        }
      }
      if (switcher.isOpen) {
        e.preventDefault();
        switcher.close(true);
        return;
      }
    }
    if (e.altKey && !mod && e.code === "KeyN") {
      e.preventDefault();
      showNewNote();
    } else if (e.altKey && !mod && e.code === "KeyM") {
      e.preventDefault();
      mode.set(mode.value === "home" ? "work" : "home");
      toast(`${MODE_LABEL[mode.value]} notes`, "info", [], 1500);
    } else if (e.altKey && !mod && e.code === "KeyD") {
      e.preventDefault();
      openDailyNote();
    } else if (mod && !e.shiftKey && !e.altKey && (e.key === "p" || e.key === "o")) {
      e.preventDefault();
      if (switcher.isOpen) switcher.close(true);
      else switcher.show();
    } else if (mod && ((!e.shiftKey && e.key === "k") || (e.shiftKey && e.code === "KeyF"))) {
      e.preventDefault();
      switcher.close(false);
      setSidebarOpen(true);
      sidebar.focusSearch();
    } else if (mod && e.key === "\\") {
      e.preventDefault();
      workspace.openToSide(workspace.active.notePath);
    } else if (e.altKey && !mod && /^Digit[1-4]$/.test(e.code)) {
      e.preventDefault();
      workspace.focusIndex(Number(e.code.slice(5)) - 1);
      grid.focusActive();
    } else if (e.altKey && !mod && e.code === "KeyW") {
      e.preventDefault();
      workspace.close(workspace.state.activePaneId);
      grid.focusActive();
    } else if (mod && e.key === ",") {
      e.preventDefault();
      void settingsDialog.show();
    } else if (mod && e.key === "s") {
      e.preventDefault(); // never show the browser's "Save page" dialog
      saveAll();
    }
  },
  { capture: true },
);

// Show links as clickable while Ctrl/Cmd is held.
const setModHeld = (on: boolean) => root.classList.toggle("mod-held", on);
window.addEventListener("keydown", (e) => (e.key === "Control" || e.key === "Meta") && setModHeld(true));
window.addEventListener("keyup", (e) => (e.key === "Control" || e.key === "Meta") && setModHeld(false));
window.addEventListener("blur", () => setModHeld(false));

// --- server events -------------------------------------------------------------

let changesTimer: ReturnType<typeof setTimeout> | null = null;
function refreshChangesSoon(): void {
  if (changesTimer) return;
  changesTimer = setTimeout(() => {
    changesTimer = null;
    void explorer.refreshChanges();
  }, 800);
}

let wasConnected = true;
const connectEvents = () => subscribe(
  (ev) => {
    switch (ev.type) {
      case "status":
        setStatus(ev.status);
        if (ide.value && explorer.showingChanges) refreshChangesSoon();
        break;
      case "note-changed":
        void buffers.remoteChanged(ev.path, ev.hash);
        break;
      case "note-deleted":
        buffers.remoteDeleted(ev.path);
        break;
      case "notes-changed":
        refreshNotesSoon();
        if (ide.value && explorer.showingChanges) refreshChangesSoon();
        setTimeout(() => void warmOfflineCache(), 3000);
        break;
      case "reconfigured":
        // Another folder or sync setup: save what's open, then start fresh.
        void buffers.flushAll().finally(() => location.reload());
        break;
    }
  },
  (connected) => {
    statusbar.setConnected(connected);
    if (connected && !wasConnected) {
      // Catch up on anything missed while disconnected.
      void refreshNotes();
      void buffers.revalidate();
      for (const b of buffers.all()) if (b.dirty) buffers.scheduleSave(b, 0);
    }
    wasConnected = connected;
  },
);

buffers.on("deleted", (path) => {
  const title = notes.find((n) => n.path === path)?.title ?? path;
  workspace.noteGone(path);
  toast(`"${title}" was deleted on another device or outside the app.`, "warn");
});
buffers.on("conflictCopy", (path, copy) => {
  toast("This note changed somewhere else while you were editing. Your text was kept; the other version was saved as a copy.", "warn", [
    { label: "Compare", run: () => compareConflict(copy) },
  ], 12_000);
  void path;
});
let lastErrorToast = 0;
buffers.on("error", (msg) => {
  statusbar.setSaveError(msg);
  if (Date.now() - lastErrorToast > 15_000) {
    lastErrorToast = Date.now();
    toast(`${msg}. Your text is kept and will be saved when possible.`, "error");
  }
});
buffers.on("changed", () => {
  if (!buffers.all().some((b) => b.lastError)) statusbar.setSaveError(null);
  statusbar.setSavedOffline(buffers.savedOffline);
});
// No connection: quietly keep the text in this browser (no toast, nothing to click).
buffers.on("offline", () => statusbar.setSavedOffline(true));
// Back online: save what's waiting now, and ask the server to sync.
window.addEventListener("online", () => {
  buffers.retryNow();
  void api.focus().catch(() => undefined);
});

/** Ctrl/Cmd+S: keep a copy in this browser at once, then save to the server (works offline too). */
function saveAll(): void {
  buffers.stashNow();
  void buffers.flushAll();
}

window.addEventListener("focus", () => void api.focus().catch(() => undefined));
window.addEventListener("beforeunload", (e) => {
  if (!buffers.hasUnsaved()) return;
  buffers.saveOnUnload();
  // Unsaved text is kept in this browser and saved next time; only warn if that failed.
  if (!buffers.stashNow()) e.preventDefault();
});
window.addEventListener("pagehide", () => buffers.saveOnUnload());

// --- boot ----------------------------------------------------------------------

async function boot(): Promise<void> {
  const placeholder = document.getElementById("app")!;
  let info;
  try {
    info = await api.info();
  } catch {
    placeholder.textContent = "Can't reach the notes server. If it's on this computer, start Notes again; otherwise check your connection.";
    return;
  }
  if (!info.configured) {
    const ssh = await api.settings().then((s) => s.sshPublicKey, () => null);
    placeholder.classList.remove("booting");
    renderSetup(placeholder, info, ssh);
    return;
  }
  placeholder.replaceWith(root);
  connectEvents();
  statusbar.setMachine(info.machineName);
  document.title = `Notes · ${info.machineName}`;
  narrowSidebarOpen = !workspace.active.notePath;
  applyIde();
  applyChrome();
  const recovered = await buffers.recoverStash();
  if (recovered) toast(`Recovered ${recovered} unsaved note${recovered === 1 ? "" : "s"} from the last session.`, "info");
  await refreshNotes();
  followMovedNotes();
  // First run, or nothing was open: show the most recent note.
  if (workspace.state.panes.every((p) => !p.notePath) && notes.length && !isNarrow()) {
    workspace.open(notes[0].path);
  }
  grid.render();
  sidebar.setActivePath(workspace.active.notePath);
  explorer.setActivePath(workspace.active.notePath);
  if (!status) api.status().then(setStatus, () => undefined);
  registerOffline();
}

/**
 * Notes that were at the root are moved into Home/ by the server. Point panes
 * restored from before the move at the new paths.
 */
function followMovedNotes(): void {
  const have = new Set(notes.map((n) => n.path));
  for (const p of workspace.state.panes) {
    if (!p.notePath || have.has(p.notePath) || modeFolderOf(p.notePath)) continue;
    const moved = `${MODE_FOLDER.home}/${p.notePath}`;
    if (have.has(moved)) workspace.renamed(p.notePath, moved);
  }
}

// --- offline ---------------------------------------------------------------------

const WARM_KEY = "notes-app:offline-warm:v1";

/** Service worker (https/localhost only) + keep every note's latest version in its cache. */
function registerOffline(): void {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  // On first install the worker takes control a moment after "ready".
  navigator.serviceWorker.addEventListener("controllerchange", () => void warmOfflineCache());
  navigator.serviceWorker.register("/sw.js").then(
    () => void navigator.serviceWorker.ready.then(() => warmOfflineCache()),
    () => undefined,
  );
}

let warming = false;
async function warmOfflineCache(): Promise<void> {
  if (warming || !navigator.serviceWorker.controller) return;
  warming = true;
  try {
    let warm: Record<string, string> = {};
    try {
      warm = JSON.parse(localStorage.getItem(WARM_KEY) ?? "{}");
    } catch {
      /* start over */
    }
    // App info and the list too, so the app can start with no server at all.
    if (!(await api.info().then(() => true, () => false))) return;
    await api.list().catch(() => undefined);
    const next: Record<string, string> = {};
    for (const n of notes.slice(0, 1000)) {
      if (warm[n.path] !== n.hash) {
        if (!notes.some((m) => m.path === n.path)) continue; // deleted meanwhile
        // Fetching through the service worker stores it in the offline cache.
        const err = await api.read(n.path).then(() => null, (e: unknown) => e as ApiError);
        if (err && err.status === 404) continue;
        if (err) return; // offline or server gone: try again next time
        await new Promise((r) => setTimeout(r, 20)); // stay out of the way
      }
      next[n.path] = n.hash;
    }
    try {
      localStorage.setItem(WARM_KEY, JSON.stringify(next));
    } catch {
      /* storage full */
    }
  } finally {
    warming = false;
  }
}

void boot();
