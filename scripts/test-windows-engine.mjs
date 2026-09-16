#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function testWindowsEngine(command, { model, audio } = {}) {
  if (process.platform !== "win32") throw new Error("Windowsで実エンジンを検証してください。");
  const result = spawnSync(command, ["--help"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `Windows音声エンジンを起動できません。DLL・VCランタイムを確認してください。\n${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /usage|options/i);
  console.log("PASS: 同梱Windows音声エンジンの実起動を確認しました。");
  if (model || audio) {
    assert.ok(model && audio, "認識試験はモデルと音声の両方が必要です");
    const recognized = spawnSync(command, ["-m", model, "-f", audio, "-l", "en", "-nt", "-np", "-ng"], { encoding: "utf8", timeout: 120_000, windowsHide: true });
    assert.ifError(recognized.error);
    assert.equal(recognized.status, 0, recognized.stderr || recognized.signal);
    assert.match(recognized.stdout, /ask not what your country can do for you/i);
    console.log("PASS: Windows音声エンジンで固定音声の実文字起こしを確認しました。");
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const staging = mkdtempSync(join(tmpdir(), "doon-whisper-windows-check-"));
  try {
    // Only the executable is copied: preinstalled build tools must not mask missing sibling DLLs.
    const command = join(staging, "whisper-cli.exe");
    copyFileSync(join(root, "src-tauri", "binaries", "whisper-cli-x86_64-pc-windows-msvc.exe"), command);
    testWindowsEngine(command, { model: process.env.DOON_TEST_MODEL, audio: process.env.DOON_TEST_AUDIO });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
