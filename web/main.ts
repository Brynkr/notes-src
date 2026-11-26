// Web UI entry point. Wires sidebar, panes, status bar and server events.

import type { NoteMeta, SyncStatusDto } from "../shared/types.ts";
import { api, subscribe } from "./api.ts";
import { BufferStore } from "./state/buffers.ts";
import { Workspace } from "./state/workspace.ts";
import { h, icons, isMac, toast } from "./ui/dom.ts";
import { PaneGrid } from "./ui/panes.ts";
import { Sidebar } from "./ui/sidebar.ts";
import { ConflictBanner, originalOf, StatusBar } from "./ui/statusbar.ts";

const workspace = new Workspace();
const buffers = new BufferStore();
let notes: NoteMeta[] = [];
let status: SyncStatusDto | null = null;

// --- actions -----------------------------------------------------------------

async function createNote(title: string): Promise<void> {
  try {
    const note = await api.create(title);
    buffers.adopt(note.path, note.text, note.hash);
    workspace.open(note.path);
    await refreshNotes();
    if (isNarrow()) setSidebarOpen(false);
    grid.focusActive();
  } catch (err) {
    toast(`Couldn't create the note: ${(err as Error).message}`, "error");
  }
}

async function deleteNote(path: string): Promise<void> {
  // Close it here first, so the server's "deleted" event isn't reported as a remote change.
  buffers.forget(path);
  workspace.noteGone(path);
  try {
    await api.remove(path);
    await refreshNotes();
    toast("Note deleted. It stays in the repo's git history.", "info");
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
      sidebar.setNotes(notes);
      sidebar.setActivePath(workspace.active.notePath);
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

const sidebar = new Sidebar({
  open: openNote,
  create: createNote,
  collapse: () => setSidebarOpen(false),
});

const grid = new PaneGrid({
  workspace,
  buffers,
  deleteNote,
  newNote: () => showNewNote(),
  extraKeys: () => [
    {
      key: "Mod-s",
      run: () => {
        void buffers.flushAll();
        return true;
      },
    },
  ],
});

const statusbar = new StatusBar({ syncNow: () => void syncNow(), setLayout: (l) => workspace.setLayout(l) });
const banner = new ConflictBanner(compareConflict);
const sidebarToggle = h("button", {
  class: "icon-btn sidebar-toggle",
  title: "Show or hide the note list",
  "aria-label": "Toggle sidebar",
  html: icons.sidebar,
  onclick: () => setSidebarOpen(!sidebarOpen()),
});
statusbar.el.prepend(sidebarToggle);

const resizer = h("div", { class: "resizer", role: "separator", "aria-orientation": "vertical", title: "Drag to resize" });
const scrim = h("div", { class: "scrim", onclick: () => setSidebarOpen(false) });
const main = h("main", { class: "main" }, banner.el, grid.el, statusbar.el);
const root = h("div", { class: "app" }, sidebar.el, resizer, scrim, main);
document.getElementById("app")!.replaceWith(root);

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
    if (e.altKey && !mod && e.code === "KeyN") {
      e.preventDefault();
      showNewNote();
    } else if (mod && !e.shiftKey && (e.key === "k" || e.key === "p")) {
      e.preventDefault();
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
    } else if (mod && e.key === "s") {
      e.preventDefault(); // never show the browser's "Save page" dialog
      void buffers.flushAll();
    }
  },
  { capture: true },
);

// --- server events -------------------------------------------------------------

let wasConnected = true;
subscribe(
  (ev) => {
    switch (ev.type) {
      case "status":
        setStatus(ev.status);
        break;
      case "note-changed":
        void buffers.remoteChanged(ev.path, ev.hash);
        break;
      case "note-deleted":
        buffers.remoteDeleted(ev.path);
        break;
      case "notes-changed":
        refreshNotesSoon();
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
});

window.addEventListener("focus", () => void api.focus().catch(() => undefined));
window.addEventListener("beforeunload", (e) => {
  if (buffers.hasUnsaved()) {
    buffers.saveOnUnload();
    e.preventDefault();
  }
});
window.addEventListener("pagehide", () => buffers.saveOnUnload());

// --- boot ----------------------------------------------------------------------

async function boot(): Promise<void> {
  narrowSidebarOpen = !workspace.active.notePath;
  applyChrome();
  try {
    const info = await api.info();
    statusbar.setMachine(info.machineName);
    document.title = `Notes · ${info.machineName}`;
  } catch {
    /* shown as disconnected */
  }
  const recovered = await buffers.recoverStash();
  if (recovered) toast(`Recovered ${recovered} unsaved note${recovered === 1 ? "" : "s"} from the last session.`, "info");
  await refreshNotes();
  // First run, or nothing was open: show the most recent note.
  if (workspace.state.panes.every((p) => !p.notePath) && notes.length && !isNarrow()) {
    workspace.open(notes[0].path);
  }
  grid.render();
  sidebar.setActivePath(workspace.active.notePath);
  if (!status) api.status().then(setStatus, () => undefined);
}

void boot();
