#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, copyFileSync, cpSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tauriTarget = process.env.TAURI_TARGET;
const bundleRoot = join(root, "src-tauri", "target", ...(tauriTarget ? [tauriTarget, "release"] : ["release"]), "bundle");
const outputRoot = join(root, "dist");
const packageSuffix = process.env.DOON_VOICE_PACKAGE_SUFFIX || (process.platform === "darwin" ? "macOS" : "Windows");
const configuration = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const quickStart = `DOON Voice — インストールと使い方

【インストール】
macOS: DMGを開き、DOON VoiceをApplicationsへ移動してください。
Windows: MSIをダブルクリックしてインストールしてください。

【初回設定】
1. DOON Voiceを起動します。
2. 「接続と設定」でマイクを許可します。
3. macOSは「カーソル位置へ入力」の許可を開き、アクセシビリティでDOON Voiceをオンにします。
   Windowsは「設定」→「プライバシーとセキュリティ」→「マイク」で、マイクとデスクトップアプリのアクセスを許可します。
   「接続と設定」で音声認識モデル（約574MB）を取得してください。初回はインターネット接続が必要です。
4. 「文章の仕上げ」で「AIなし」または使うAIを選びます。ChatGPT/Claude/Geminiは対応CLIを準備してログインしてください。
5. ローカルAIを使う場合は「Ollamaを自動インストール」「Gemmaを取得」を実行してください。

【基本操作】
1. 文字を入力したいアプリの入力欄へカーソルを置きます。
2. ホーム画面に表示されている開始・停止キーを押します。
3. 「聞いています」→「考えています」→「入力しました」の順に進み、文章がカーソル位置へ入力されます。
4. ショートカットは「接続と設定」で変更できます。

【補足】
音声認識モデルは初回起動後に取得します。録音ファイルは処理終了時に削除し、次回起動時に期限切れファイルを回収します。強制終了などで一時的に残ることがあります。
「AIなし」ではAIへ送信しません。クラウドAIを選ぶと本文と辞書を対応CLIへ渡します。詳しくはPRIVACY.mdをお読みください。
未署名アプリはOSの保護機能や組織のポリシーで起動できない場合があります。配布元を確認し、OSの案内に従ってください。
`;

export function installerArch(platform, target, hostArch) {
  const architecture = target ? target.split("-")[0] : hostArch;
  if (target && !target.endsWith(platform === "darwin" ? "apple-darwin" : "pc-windows-msvc")) {
    throw new Error(`対象OSとTAURI_TARGETが一致しません: ${target}`);
  }
  if (["x64", "x86_64"].includes(architecture)) return "x64";
  if (["arm64", "aarch64"].includes(architecture)) return platform === "darwin" ? "aarch64" : "arm64";
  throw new Error(`未対応の対象アーキテクチャです: ${architecture}`);
}

export function selectInstaller({ directory, productName, version: expectedVersion, platform, arch }) {
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const names = [...new Set([productName, productName.replaceAll(" ", ".")])].map(escape).join("|");
  const suffix = platform === "darwin" ? "\\.dmg" : "(?:_[A-Za-z]{2}-[A-Za-z]{2})?\\.msi|_setup\\.exe";
  const pattern = new RegExp(`^(?:${names})_${escape(expectedVersion)}_${escape(arch)}(?:${suffix})$`);
  const subdirectories = platform === "darwin" ? ["dmg"] : ["msi", "nsis"];
  const candidates = subdirectories.flatMap((subdirectory) => {
    const path = join(directory, subdirectory);
    if (!existsSync(path)) return [];
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isFile() && pattern.test(entry.name))
      .map((entry) => join(path, entry.name));
  });
  if (candidates.length === 0) throw new Error(`現バージョン ${expectedVersion} / ${arch} に一致するインストーラーが見つかりません。npm run dist を確認してください。`);
  if (candidates.length > 1) throw new Error(`一致するインストーラーが複数あり曖昧です: ${candidates.map((entry) => basename(entry)).join("、")}`);
  return candidates[0];
}

function packageInstaller() {
  if (!["darwin", "win32"].includes(process.platform)) throw new Error("ZIP配布パッケージはmacOSまたはWindows上で作成してください。");
  if (configuration.version !== version) throw new Error("package.jsonとTauri設定のバージョンが一致しません。");
  if (!/^[A-Za-z0-9-]+$/.test(packageSuffix)) throw new Error("ZIP名のサフィックスは英数字とハイフンで指定してください。");
  const installer = selectInstaller({ directory: bundleRoot, productName: configuration.productName, version, platform: process.platform, arch: installerArch(process.platform, tauriTarget, process.arch) });
  const staging = mkdtempSync(join(tmpdir(), "doon-voice-installer-"));
  try {
    const packageDir = join(staging, "DOON Voice Installer");
    mkdirSync(packageDir);
    copyFileSync(installer, join(packageDir, basename(installer)));
    writeFileSync(join(packageDir, "README.txt"), quickStart, "utf8");
    for (const name of ["OSS-NOTICES.md", "PRIVACY.md"]) copyFileSync(join(root, "docs", name), join(packageDir, name));
    cpSync(join(root, "docs", "licenses"), join(packageDir, "licenses"), { recursive: true });
    const temporaryZip = join(staging, "installer.zip");
    if (process.platform === "darwin") {
      execFileSync("ditto", ["-c", "-k", "--norsrc", packageDir, temporaryZip], { stdio: "inherit" });
    } else {
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Compress-Archive -LiteralPath $env.DOON_ZIP_SOURCE -DestinationPath $env.DOON_ZIP_OUTPUT -Force"], {
        stdio: "inherit", env: { ...process.env, DOON_ZIP_SOURCE: packageDir, DOON_ZIP_OUTPUT: temporaryZip },
      });
    }
    mkdirSync(outputRoot, { recursive: true });
    const output = join(outputRoot, `DOON Voice-${packageSuffix}.zip`);
    copyFileSync(temporaryZip, `${output}.part`);
    renameSync(`${output}.part`, output);
    console.log(`作成しました: ${output}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) packageInstaller();
