#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageLock = join(root, "package-lock.json");
const marker = join(root, "node_modules", ".doon-voice-setup.json");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const setupLabel = "npm run setup";
const appLabel = "npm run app";

function lockFingerprint() {
  return createHash("sha256").update(readFileSync(packageLock)).digest("hex");
}

function setupIsCurrent(fingerprint) {
  if (!existsSync(marker)) return false;
  try {
    return JSON.parse(readFileSync(marker, "utf8")).packageLockSha256 === fingerprint;
  } catch {
    return false;
  }
}

function runNpm(script) {
  const result = spawnSync(npmCommand, ["run", script], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) {
    console.error(`npmを起動できませんでした: ${result.error.message}`);
  }
  if (result.signal) {
    console.error(`npmがシグナル ${result.signal} で終了しました。`);
  }
  return result;
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 20) {
  console.error(`Node.js 20以上が必要です。現在のバージョン: ${process.versions.node}`);
  process.exit(1);
}

const fingerprint = lockFingerprint();
if (!setupIsCurrent(fingerprint)) {
  console.log(`初回セットアップを始めます（${setupLabel}）。`);
  const setup = runNpm("setup");
  if (setup.status !== 0) process.exit(setup.status ?? 1);
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, `${JSON.stringify({ packageLockSha256: fingerprint }, null, 2)}\n`, "utf8");
} else {
  console.log("セットアップ済みです。起動へ進みます。");
}

if (process.argv.includes("--setup-only")) {
  console.log("セットアップ確認が完了しました。");
  process.exit(0);
}

console.log(`DOON Voiceを起動します（${appLabel}）。`);
const app = runNpm("app");
process.exit(app.status ?? 1);
