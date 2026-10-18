import { clamp } from "./math";

/** Raw control axes, each in [-1, 1]. */
export interface RawAxes {
  ws: number;
  ad: number;
  qe: number;
  arrowLR: number;
  arrowUD: number;
  /** [ and ] — commands the autopilot's target altitude. */
  bracket: number;
  brake: boolean;
  boost: boolean;
}

export type ActionName =
  | "focus"
  | "toggleFollow"
  | "toggleHelp"
  | "toggleFeed"
  | "timeWarp"
  | "reset";

const ACTION_KEYS: Record<string, ActionName> = {
  KeyF: "toggleFollow",
  KeyG: "focus",
  KeyH: "toggleHelp",
  KeyK: "toggleFeed",
  KeyT: "timeWarp",
  Backspace: "reset",
};

/** True when the user is typing into a control, so keys shouldn't fly. */
function isFormTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ["INPUT", "SELECT", "TEXTAREA", "BUTTON", "OPTION"].includes(target.tagName)
  );
}

export class Controls {
  private readonly pressed = new Set<string>();
  private readonly listeners = new Map<ActionName, Set<() => void>>();

  constructor(private readonly target: Window = window) {
    this.target.addEventListener("keydown", this.onKeyDown);
    this.target.addEventListener("keyup", this.onKeyUp);
    this.target.addEventListener("blur", this.releaseAll);
  }

  on(action: ActionName, handler: () => void): void {
    const set = this.listeners.get(action) ?? new Set();
    set.add(handler);
    this.listeners.set(action, set);
  }

  axes(): RawAxes {
    const held = (code: string): number => (this.pressed.has(code) ? 1 : 0);
    const axis = (pos: string, neg: string): number => clamp(held(pos) - held(neg), -1, 1);

    return {
      ws: axis("KeyW", "KeyS"),
      ad: axis("KeyD", "KeyA"),
      qe: axis("KeyE", "KeyQ"),
      arrowLR: axis("ArrowRight", "ArrowLeft"),
      arrowUD: axis("ArrowUp", "ArrowDown"),
      bracket: axis("BracketRight", "BracketLeft"),
      brake: this.pressed.has("Space"),
      boost: this.pressed.has("ShiftLeft") || this.pressed.has("ShiftRight"),
    };
  }

  destroy(): void {
    this.target.removeEventListener("keydown", this.onKeyDown);
    this.target.removeEventListener("keyup", this.onKeyUp);
    this.target.removeEventListener("blur", this.releaseAll);
    this.pressed.clear();
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (isFormTarget(event.target)) return;

    const action = ACTION_KEYS[event.code];
    if (action && !event.repeat) {
      event.preventDefault();
      for (const handler of this.listeners.get(action) ?? []) handler();
      return;
    }

    // Stop the page scrolling out from under the simulation.
    if (event.code.startsWith("Arrow") || event.code === "Space") event.preventDefault();
    this.pressed.add(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.pressed.delete(event.code);
  };

  private readonly releaseAll = (): void => {
    this.pressed.clear();
  };
}
