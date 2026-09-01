#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import process from "node:process";

const checkOnly = process.argv.includes("--check-only");
const isWindows = process.platform === "win32";
const lookup = isWindows ? "where" : "which";
const npmCommand = isWindows ? "npm.cmd" : "npm";

function available(command) {
  const result = spawnSync(lookup, [command], { stdio: "ignore" });
  return result.status === 0;
}

function works(command, args = []) {
  const result = spawnSync(command, args, { stdio: "ignore" });
  return result.status === 0;
}

function version(command, args = ["--version"]) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "未検出";
  }
}

function majorVersion(value) {
  const match = value.match(/(\d+)/);
  return match ? Number(match[1]) : 0;
}

const nodeVersion = version(process.execPath);
const checks = [
  ["Node.js", majorVersion(nodeVersion) >= 20, nodeVersion],
  ["Rust cargo", available("cargo"), version("cargo")],
  ["Rust rustc", available("rustc"), version("rustc")],
];

if (process.platform === "darwin") {
  checks.push(["Xcode Command Line Tools", available("xcode-select") && works("xcode-select", ["-p"]), "macOSのビルドに必要"]);
}

console.log("DOON Voice セットアップ確認");
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? "✓" : "!"} ${name}: ${detail}`);
}

if (!checkOnly) {
  console.log("\nnpm依存関係をインストールしています…");
  const result = spawnSync(npmCommand, ["ci"], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const missing = checks.filter(([, ok]) => !ok).map(([name]) => name);
if (missing.length > 0) {
  console.error(`\n不足している環境: ${missing.join("、")}`);
  if (isWindows) {
    console.error("WindowsではRust、Visual Studio Build Tools（C++）、WebView2を準備してください。");
  } else if (process.platform === "darwin") {
    console.error("macOSではRustとXcode Command Line Toolsを準備してください。");
  }
  console.error("Ollama、Codex CLI、Claude Code、AIモデルはDOON Voiceの接続と設定から別途準備します。");
  process.exit(1);
}

console.log("\nセットアップ確認が完了しました。");
console.log("起動: npm run app");
console.log("初回起動後: 接続と設定から音声認識モデルと、必要ならローカルAIモデルを取得してください。");
