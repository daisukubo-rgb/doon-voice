#!/bin/zsh
set -euo pipefail

PROJECT_DIR="${0:A:h:h}"
DESKTOP_DIR="$PROJECT_DIR"
TAURI_CONFIG="$DESKTOP_DIR/src-tauri/tauri.conf.json"
INFO_PLIST="$DESKTOP_DIR/src-tauri/Info.plist"
RUST_SOURCE="$DESKTOP_DIR/src-tauri/src/lib.rs"
FRONTEND="$DESKTOP_DIR/src/App.tsx"
SHORTCUT_UTIL="$DESKTOP_DIR/src/shortcut.ts"
SHORTCUT_CAPABILITY="$DESKTOP_DIR/src-tauri/capabilities/desktop.json"
SETUP_SCRIPT="$DESKTOP_DIR/scripts/setup.mjs"
PACKAGE_JSON="$DESKTOP_DIR/package.json"
PRIVACY="$DESKTOP_DIR/docs/PRIVACY.md"
README="$DESKTOP_DIR/README.md"
WORKFLOW="$PROJECT_DIR/.github/workflows/release.yml"

for required in "$TAURI_CONFIG" "$INFO_PLIST" "$RUST_SOURCE" "$FRONTEND" "$SHORTCUT_UTIL" "$SHORTCUT_CAPABILITY" "$SETUP_SCRIPT" "$PACKAGE_JSON" "$PRIVACY" "$README" "$WORKFLOW"; do
  if [[ ! -f "$required" ]]; then
    print -u2 "FAIL: 配布に必要なファイルがありません: $required"
    exit 1
  fi
done

if ! rg -F -q 'NSMicrophoneUsageDescription' "$INFO_PLIST"; then
  print -u2 'FAIL: macOSのマイク利用目的がInfo.plistに定義されていません'
  exit 1
fi

if ! rg -F -q '"setup": "node scripts/setup.mjs"' "$PACKAGE_JSON" || ! rg -F -q '"doctor": "node scripts/setup.mjs --check-only"' "$PACKAGE_JSON"; then
  print -u2 'FAIL: リポジトリからの初回セットアップ導線がありません'
  exit 1
fi

if ! rg -F -q '"test": "npm run test:compile' "$PACKAGE_JSON" || ! rg -F -q -- '- run: npm test' "$PROJECT_DIR/.github/workflows/ci.yml"; then
  print -u2 'FAIL: TypeScriptの単体テストがローカル実行とCIの両方に定義されていません'
  exit 1
fi

if ! rg -F -q 'npm run setup' "$README" || ! rg -F -q 'npm run doctor' "$README"; then
  print -u2 'FAIL: READMEにリポジトリからのセットアップ手順がありません'
  exit 1
fi

if rg -F -q '利用履歴（日時、録音時間、文字起こし、整形結果）' "$PRIVACY"; then
  print -u2 'FAIL: プライバシー文書に廃止した履歴保存の記載が残っています'
  exit 1
fi

if ! rg -F -q '"productName": "DOON Voice"' "$TAURI_CONFIG" || ! rg -F -q '"targets": "all"' "$TAURI_CONFIG"; then
  print -u2 'FAIL: macOS/Windows向けのDOON Voice配布設定がありません'
  exit 1
fi

if ! rg -F -q 'tauri_plugin_global_shortcut' "$RUST_SOURCE" || ! rg -F -q 'global-shortcut:allow-register' "$SHORTCUT_CAPABILITY" || ! rg -F -q 'global-shortcut:allow-unregister' "$SHORTCUT_CAPABILITY" || ! rg -F -q '開始・停止キー' "$FRONTEND"; then
  print -u2 'FAIL: 音声入力の全体ショートカット設定がありません'
  exit 1
fi

if ! rg -F -q 'codex login' "$RUST_SOURCE" || ! rg -F -q 'claude' "$RUST_SOURCE"; then
  print -u2 'FAIL: 公式CLIのログイン導線がありません'
  exit 1
fi

if ! rg -F -q 'local_llm_status' "$RUST_SOURCE" || ! rg -F -q 'pull_local_model' "$RUST_SOURCE"; then
  print -u2 'FAIL: 端末内LLMの検出・モデル取得導線がありません'
  exit 1
fi

if ! rg -F -q 'ローカルAI' "$FRONTEND" || ! rg -F -q 'Ollamaを自動インストール' "$FRONTEND"; then
  print -u2 'FAIL: 端末内LLMを使うUIがありません'
  exit 1
fi

if ! rg -F -q '文章を整えるAI' "$FRONTEND" || ! rg -F -q 'doon-voice-output-target' "$FRONTEND"; then
  print -u2 'FAIL: 音声入力の出力先を選ぶ設定がありません'
  exit 1
fi

if ! rg -F -q 'paste_to_active_app' "$RUST_SOURCE" || ! rg -F -q 'カーソル位置へ入力' "$FRONTEND"; then
  print -u2 'FAIL: カーソル位置への直接入力がありません'
  exit 1
fi

if rg -i -q 'password|api.?key' "$FRONTEND"; then
  print -u2 'FAIL: UIにパスワードまたはAPIキーの入力導線があります'
  exit 1
fi

if ! rg -F -q 'macos-14' "$WORKFLOW" || ! rg -F -q 'x86_64-apple-darwin' "$WORKFLOW" || ! rg -F -q 'windows-latest' "$WORKFLOW"; then
  print -u2 'FAIL: GitHub ActionsにApple Silicon/Intel macOSとWindowsのビルドがありません'
  exit 1
fi

print 'PASS: GitHub Releases向けのmacOS/Windows配布と公式ログイン導線が定義されています'
