#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") throw new Error("Windowsで実エンジンを検証してください。");
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const staging = mkdtempSync(join(tmpdir(), "doon-whisper-windows-check-"));
try {
  cpSync(join(root, "src-tauri", "resources", "engine", "windows-x64", "whisper"), staging, { recursive: true });
  const command = join(staging, "whisper-cli.exe");
  copyFileSync(join(root, "src-tauri", "binaries", "whisper-cli-x86_64-pc-windows-msvc.exe"), command);
  const result = spawnSync(command, ["--help"], { cwd: staging, encoding: "utf8", timeout: 15_000, windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `Windows音声エンジンを起動できません。DLL・VCランタイムを確認してください。\n${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /usage|options/i);
  console.log("PASS: 同梱Windows音声エンジンの実起動を確認しました。");
} finally {
  rmSync(staging, { recursive: true, force: true });
}
