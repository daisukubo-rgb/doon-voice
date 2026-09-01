#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tauriTarget = process.env.TAURI_TARGET;
const bundleRoot = join(root, "src-tauri", "target", ...(tauriTarget ? [tauriTarget, "release"] : ["release"]), "bundle");
const outputRoot = join(root, "dist");
const packageSuffix = process.env.DOON_VOICE_PACKAGE_SUFFIX || (process.platform === "darwin" ? "macOS" : "Windows");
const quickStart = `DOON Voice — インストールと使い方

【インストール】
macOS: DMGを開き、DOON VoiceをApplicationsへ移動してください。
Windows: MSIをダブルクリックしてインストールしてください。

【初回設定】
1. DOON Voiceを起動します。
2. 「接続と設定」でマイクを許可します。
3. macOSは「カーソル位置へ入力」の許可を開き、アクセシビリティでDOON Voiceをオンにします。
4. 「文章の仕上げ」で使うAIを選びます。ChatGPT/Claudeは「接続する」から公式画面でログインしてください。
5. ローカルAIを使う場合は「Ollamaを入れる」「モデルを取得」を実行してください。

【基本操作】
1. 文字を入力したいアプリの入力欄へカーソルを置きます。
2. ホーム画面に表示されている開始・停止キーを押します。
3. 「聞いています」→「文章を整えています」→「入力しました」の順に進み、文章がカーソル位置へ入力されます。
4. ショートカットは「接続と設定」で変更できます。

【補足】
音声認識モデルは初回起動後に取得します。録音ファイルは文字起こし後に削除されます。
未署名アプリの警告が出た場合は、macOSはアプリを右クリックして「開く」、Windowsは発行元を確認して実行してください。
`;

function firstFile(directory, extensions) {
  if (!existsSync(directory)) return null;
  const file = readdirSync(directory).find((entry) => extensions.some((extension) => entry.toLowerCase().endsWith(extension)));
  return file ? join(directory, file) : null;
}

function packageMac() {
  const installer = firstFile(join(bundleRoot, "dmg"), [".dmg"]);
  if (!installer) throw new Error("macOS用DMGが見つかりません。先に npm run dist を実行してください。");
  const staging = mkdtempSync(join(tmpdir(), "doon-voice-installer-"));
  const packageDir = join(staging, "DOON Voice Installer");
  mkdirSync(packageDir, { recursive: true });
  copyFileSync(installer, join(packageDir, basename(installer)));
  writeFileSync(join(packageDir, "README.txt"), quickStart, "utf8");
  const output = join(outputRoot, `DOON Voice-${packageSuffix}.zip`);
  rmSync(output, { force: true });
  execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", packageDir, output], { stdio: "inherit" });
  rmSync(staging, { recursive: true, force: true });
  console.log(`作成しました: ${output}`);
}

function packageWindows() {
  const installer = firstFile(join(bundleRoot, "msi"), [".msi"]) ?? firstFile(join(bundleRoot, "nsis"), [".exe"]);
  if (!installer) throw new Error("Windows用MSI/インストーラーが見つかりません。Windows上で npm run dist を実行してください。");
  const staging = mkdtempSync(join(tmpdir(), "doon-voice-installer-"));
  const stagedInstaller = join(staging, basename(installer));
  copyFileSync(installer, stagedInstaller);
  writeFileSync(join(staging, "README.txt"), quickStart, "utf8");
  const output = join(outputRoot, `DOON Voice-${packageSuffix}.zip`);
  rmSync(output, { force: true });
  const command = `Compress-Archive -Path '${join(staging, "*").replaceAll("'", "''")}' -DestinationPath '${output.replaceAll("'", "''")}' -Force`;
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { stdio: "inherit" });
  rmSync(staging, { recursive: true, force: true });
  console.log(`作成しました: ${output}`);
}

if (!existsSync(outputRoot)) mkdirSync(outputRoot, { recursive: true });
if (process.platform === "darwin") packageMac();
else if (process.platform === "win32") packageWindows();
else throw new Error("ZIP配布パッケージはmacOSまたはWindows上で作成してください。");
