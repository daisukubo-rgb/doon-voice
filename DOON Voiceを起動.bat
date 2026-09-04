@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20以上が必要です。ダウンロードページを開きます。
  start "" "https://nodejs.org/ja/download"
  echo Node.jsをインストール後、もう一度このファイルを開いてください。
  pause
  exit /b 1
)

node "%~dp0scripts\launch.mjs"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo DOON Voiceを起動できませんでした。上に表示された内容を確認してください。
  pause
)

exit /b %EXIT_CODE%
