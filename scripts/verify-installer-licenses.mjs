#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installerArch, selectInstaller } from "./package-installer-zip.mjs";
import { verifyLicenses } from "./check-licenses.mjs";
import { testWindowsEngine } from "./test-windows-engine.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const config = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const target = process.env.TAURI_TARGET;
const directory = join(root, "src-tauri", "target", ...(target ? [target] : []), "release", "bundle");
const installer = selectInstaller({ directory, productName: config.productName, version: config.version, platform: process.platform, arch: installerArch(process.platform, target, process.arch) });
const temporary = mkdtempSync(join(tmpdir(), "doon-installer-license-check-"));

function findResources(directory) {
  if (existsSync(join(directory, "licenses", "inventory.json"))) return directory;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const match = findResources(join(directory, entry.name));
    if (match) return match;
  }
  return null;
}

let mounted = false;
try {
  if (process.platform === "darwin") {
    execFileSync("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", temporary, installer], { stdio: "inherit" });
    mounted = true;
  } else if (process.platform === "win32") {
    // Administrative extraction expands files without installing or launching the app.
    execFileSync("msiexec.exe", ["/a", installer, "/qn", `TARGETDIR=${temporary}`], { stdio: "inherit" });
  } else {
    throw new Error("インストーラーの展開検査はmacOSまたはWindowsで実行してください。");
  }
  const resources = findResources(temporary);
  if (!resources) throw new Error("展開したインストーラー内にlicenses/inventory.jsonがありません。");
  if (process.platform === "darwin") {
    // Ad-hoc signing needs no certificate, but its bundle seal must be valid.
    const application = resolve(resources, "..", "..");
    execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", application], { stdio: "inherit" });
    const entitlements = execFileSync("codesign", ["-d", "--entitlements", ":-", application], { encoding: "utf8", timeout: 10_000, stdio: "pipe" });
    if (!entitlements.trim()) throw new Error("署名済みアプリにentitlementがありません。");
    const declared = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", "--", "-"], { input: entitlements, encoding: "utf8", timeout: 10_000 }));
    if (declared["com.apple.security.device.audio-input"] !== true) {
      throw new Error("署名済みアプリにマイク利用のentitlementがありません。");
    }
    console.log("PASS: 署名済みアプリのマイク利用entitlementを確認しました。");
    // A valid seal does not prove that Hardened Runtime can load the engine.
    // Exercise the signed, installed payload before declaring a DMG usable.
    execFileSync(join(application, "Contents", "MacOS", "whisper-cli"), ["--help"], { timeout: 10_000, stdio: "pipe" });
    console.log("PASS: インストーラー内の署名済み音声認識エンジンが起動しました。");
  } else if (process.platform === "win32") {
    testWindowsEngine(join(resources, "whisper-cli.exe"), { model: process.env.DOON_TEST_MODEL, audio: process.env.DOON_TEST_AUDIO });
    if (process.env.DOON_TEST_NATIVE_APP === "1") {
      execFileSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-File", join(root, "scripts", "test-windows-app.ps1"), "-Directory", resources], { timeout: 60_000, stdio: "inherit" });
    }
  }
  const count = verifyLicenses(resources);
  console.log(`PASS: インストーラー内の${count}件のライセンス原文を確認しました。`);
} finally {
  if (mounted) execFileSync("hdiutil", ["detach", temporary], { stdio: "inherit" });
  rmSync(temporary, { recursive: true, force: true });
}
