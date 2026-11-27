// IDE mode on or off, per device (like the layout and the Home/Work mode).

const KEY = "notes-app:ide:v1";

type Listener = (on: boolean) => void;

export class IdeStore {
  private on = false;
  private readonly listeners: Listener[] = [];

  constructor() {
    try {
      this.on = localStorage.getItem(KEY) === "1";
    } catch {
      /* storage blocked: notes mode */
    }
  }

  get value(): boolean {
    return this.on;
  }

  set(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    try {
      localStorage.setItem(KEY, on ? "1" : "0");
    } catch {
      /* not remembered, still switched */
    }
    for (const fn of this.listeners) fn(on);
  }

  onChange(fn: Listener): void {
    this.listeners.push(fn);
  }
}
