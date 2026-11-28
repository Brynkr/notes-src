// IDE mode's UI, in its own file so notes mode never downloads or parses it:
// web/main.ts imports this the first time IDE mode is switched on.
export { Explorer } from "./ui/explorer.ts";
export { DiffDialog } from "./ui/diffview.ts";
