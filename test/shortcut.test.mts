import {
  DEFAULT_SHORTCUT,
  shortcutCaptureResult,
  shortcutFromKeyboardEvent,
  shortcutLabel,
} from "../src/shortcut.js";
import {
  DEFAULT_OUTPUT_TARGET,
  isOutputTarget,
  outputTargetLabel,
} from "../src/output-target.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function keyEvent(values: Partial<KeyboardEvent>): KeyboardEvent {
  return values as KeyboardEvent;
}

assert(DEFAULT_SHORTCUT === "Ctrl+Alt+Space", "標準キーはControl + Option/Alt + Spaceにする");
assert(
  shortcutFromKeyboardEvent(keyEvent({ code: "Space", ctrlKey: true, altKey: true })) === "Ctrl+Alt+Space",
  "Spaceと修飾キーをTauri用のショートカットへ変換する",
);
assert(
  shortcutFromKeyboardEvent(keyEvent({ code: "KeyV", metaKey: true, shiftKey: true })) === "Command+Shift+V",
  "Commandを含む組み合わせを変換する",
);
assert(
  shortcutFromKeyboardEvent(keyEvent({ code: "KeyA" })) === null,
  "修飾キーのない単独キーは登録しない",
);
const capturedShortcut = shortcutCaptureResult(keyEvent({ key: "v", code: "KeyV", ctrlKey: true, altKey: true }));
assert(
  capturedShortcut.kind === "shortcut" && capturedShortcut.shortcut === "Ctrl+Alt+V",
  "キー入力の焦点に関係なく、ウィンドウで受け取った組み合わせを登録値へ変換する",
);
assert(
  shortcutCaptureResult(keyEvent({ key: "Escape", code: "Escape" })).kind === "cancel",
  "Escはショートカット登録を取り消す",
);
assert(
  shortcutCaptureResult(keyEvent({ key: "v", code: "KeyV", ctrlKey: true, altKey: true, repeat: true })).kind === "invalid",
  "押し続けによる連続入力では重複して登録しない",
);
assert(shortcutLabel("Ctrl+Alt+Space", true) === "⌃ ⌥ Space", "Macでは見慣れた記号で表示する");
assert(shortcutLabel("Ctrl+Alt+Space", false) === "Ctrl + Alt + Space", "Windowsでは文字で表示する");
assert(DEFAULT_OUTPUT_TARGET === "codex", "標準の出力先はChatGPTにする");
assert(outputTargetLabel("local") === "このPCのAI", "端末内AIの選択肢を表示する");
assert(isOutputTarget("claude"), "Claudeを有効な出力先として扱う");
assert(!isOutputTarget("unknown"), "未知の出力先は保存しない");

console.info("PASS: ショートカットの変換と表示を検証しました");
