#!/bin/zsh

set -u

PROJECT_DIR="${0:A:h}"
cd "$PROJECT_DIR"

if ! command -v node >/dev/null 2>&1; then
  print -u2 'Node.js 20以上が必要です。ダウンロードページを開きます。'
  open 'https://nodejs.org/ja/download' >/dev/null 2>&1 || true
  read -r '?Node.jsをインストール後、もう一度このファイルを開いてください。Enterで閉じます。'
  exit 1
fi

node "$PROJECT_DIR/scripts/launch.mjs"
EXIT_CODE=$?

if (( EXIT_CODE != 0 )); then
  print -u2 ''
  print -u2 'DOON Voiceを起動できませんでした。上に表示された内容を確認してください。'
  read -r '?Enterで閉じます。'
fi

exit "$EXIT_CODE"
