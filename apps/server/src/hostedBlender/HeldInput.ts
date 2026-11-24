import type { HelperCommand } from "./HelperProtocol.ts";

/**
 * The keys and buttons the helper has been told are down. Presses already down (browser
 * auto-repeat) and releases of keys that aren't are dropped, and a handoff releases the rest.
 */
export class HeldInput {
  private readonly keys = new Set<number>();
  private readonly buttons = new Set<number>();

  /** Records a command about to be sent; `false` means the helper must not get it. */
  shouldSend(command: HelperCommand): boolean {
    if (command.type === "key") return this.toggle(this.keys, command.code, command.pressed);
    if (command.type === "pointerButton") {
      return this.toggle(this.buttons, command.button, command.pressed);
    }
    return true;
  }

  releaseAll(): HelperCommand[] {
    const released: HelperCommand[] = [
      ...Array.from(this.keys, (code): HelperCommand => ({ type: "key", code, pressed: false })),
      ...Array.from(this.buttons, (button): HelperCommand => ({
        type: "pointerButton",
        button,
        pressed: false,
      })),
    ];
    this.keys.clear();
    this.buttons.clear();
    return released;
  }

  private toggle(held: Set<number>, code: number, pressed: boolean) {
    if (held.has(code) === pressed) return false;
    if (pressed) held.add(code);
    else held.delete(code);
    return true;
  }
}
