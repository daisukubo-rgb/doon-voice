export const DEFAULT_SHORTCUT = "Ctrl+Alt+Space";

type ShortcutKeyboardEvent = Pick<KeyboardEvent, "code" | "key" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "repeat">;

export type ShortcutCaptureResult =
  | { kind: "cancel" }
  | { kind: "shortcut"; shortcut: string }
  | { kind: "invalid" };

function keyName(code: string): string | null {
  if (code === "Space") return "Space";
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return null;
}

export function shortcutFromKeyboardEvent(event: ShortcutKeyboardEvent): string | null {
  const key = keyName(event.code);
  if (!key) return null;

  const modifiers = [
    event.metaKey ? "Command" : "",
    event.ctrlKey ? "Ctrl" : "",
    event.altKey ? "Alt" : "",
    event.shiftKey ? "Shift" : "",
  ].filter(Boolean);

  return modifiers.length ? [...modifiers, key].join("+") : null;
}

export function shortcutCaptureResult(event: ShortcutKeyboardEvent): ShortcutCaptureResult {
  if (event.key === "Escape") return { kind: "cancel" };
  if (event.repeat) return { kind: "invalid" };
  const shortcut = shortcutFromKeyboardEvent(event);
  return shortcut ? { kind: "shortcut", shortcut } : { kind: "invalid" };
}

export function shortcutLabel(shortcut: string, isMac: boolean): string {
  const labels: Record<string, string> = isMac
    ? { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Command: "⌘" }
    : { Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift", Command: "Win" };

  return shortcut.split("+").map((part) => labels[part] ?? part).join(isMac ? " " : " + ");
}
