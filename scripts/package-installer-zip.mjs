#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const bundleRoot = join(root, "src-tauri", "target", "release", "bundle");
const outputRoot = join(root, "dist");

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
  execFileSync("mkdir", ["-p", packageDir]);
  copyFileSync(installer, join(packageDir, basename(installer)));
  writeFileSync(join(packageDir, "インストール方法.txt"), "DMGをダブルクリックして開き、DOON VoiceをApplicationsへ移動してください。\n", "utf8");
  const output = join(outputRoot, "DOON Voice-macOS.zip");
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
  const output = join(outputRoot, "DOON Voice-Windows.zip");
  rmSync(output, { force: true });
  const command = `Compress-Archive -Path '${stagedInstaller.replaceAll("'", "''")}' -DestinationPath '${output.replaceAll("'", "''")}' -Force`;
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { stdio: "inherit" });
  rmSync(staging, { recursive: true, force: true });
  console.log(`作成しました: ${output}`);
}

if (!existsSync(outputRoot)) execFileSync("mkdir", ["-p", outputRoot]);
if (process.platform === "darwin") packageMac();
else if (process.platform === "win32") packageWindows();
else throw new Error("ZIP配布パッケージはmacOSまたはWindows上で作成してください。");
