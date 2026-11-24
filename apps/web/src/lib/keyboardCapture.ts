interface KeyboardOwner {
  readonly element: HTMLElement;
  readonly onKey: (event: KeyboardEvent) => void;
  /** Keys the app keeps, such as its focus shortcuts. */
  readonly passThrough: (event: KeyboardEvent) => boolean;
}

let owner: KeyboardOwner | null = null;

const onKeyboardEvent = (event: KeyboardEvent) => {
  const current = owner;
  if (current === null || !(event.target instanceof Node)) return;
  if (!current.element.contains(event.target) || current.passThrough(event)) return;
  // App shortcuts listen on window too; only a listener registered before theirs beats them.
  event.stopImmediatePropagation();
  event.preventDefault();
  current.onKey(event);
};

/**
 * Lets one element own the whole keyboard while it has focus, as a remote Blender does.
 * Installed at startup, so it runs ahead of every shortcut listener the app adds later.
 */
export function installKeyboardCapture(target: Window = window): () => void {
  target.addEventListener("keydown", onKeyboardEvent, true);
  target.addEventListener("keyup", onKeyboardEvent, true);
  return () => {
    target.removeEventListener("keydown", onKeyboardEvent, true);
    target.removeEventListener("keyup", onKeyboardEvent, true);
  };
}

export function captureKeyboard(
  element: HTMLElement,
  handlers: Omit<KeyboardOwner, "element">,
): () => void {
  const next = { element, ...handlers };
  owner = next;
  return () => {
    if (owner === next) owner = null;
  };
}
