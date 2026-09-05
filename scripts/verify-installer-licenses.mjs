#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installerArch, selectInstaller } from "./package-installer-zip.mjs";
import { verifyLicenses } from "./check-licenses.mjs";

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
    execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", resolve(resources, "..", "..")], { stdio: "inherit" });
  }
  const count = verifyLicenses(resources);
  console.log(`PASS: インストーラー内の${count}件のライセンス原文を確認しました。`);
} finally {
  if (mounted) execFileSync("hdiutil", ["detach", temporary], { stdio: "inherit" });
  rmSync(temporary, { recursive: true, force: true });
}
