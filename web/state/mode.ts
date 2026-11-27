// The current mode (Home or Work), per device, like the layout.

import { isMode, type Mode } from "../../shared/modes.ts";

const KEY = "notes-app:mode:v1";

type Listener = (mode: Mode) => void;

export class ModeStore {
  private current: Mode = "home";
  private readonly listeners: Listener[] = [];

  constructor() {
    try {
      const saved = localStorage.getItem(KEY);
      if (isMode(saved)) this.current = saved;
    } catch {
      /* storage blocked: default to Home */
    }
  }

  get value(): Mode {
    return this.current;
  }

  set(mode: Mode): void {
    if (mode === this.current) return;
    this.current = mode;
    try {
      localStorage.setItem(KEY, mode);
    } catch {
      /* not remembered, still switched */
    }
    for (const fn of this.listeners) fn(mode);
  }

  onChange(fn: Listener): void {
    this.listeners.push(fn);
  }
}
