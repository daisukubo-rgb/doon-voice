#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function testWindowsEngine(command, { model, audio, variant = "compatible" } = {}) {
  if (process.platform !== "win32") throw new Error("Windowsで実エンジンを検証してください。");
  assert.ok(["compatible", "avx2"].includes(variant), "未対応のエンジン種別です");
  const manifest = variant === "avx2" ? "windows-avx2-build.json" : "windows-build.json";
  const provenance = JSON.parse(readFileSync(new URL(`../src-tauri/resources/engine/${manifest}`, import.meta.url), "utf8"));
  assert.equal(createHash("sha256").update(readFileSync(command)).digest("hex"), provenance.sha256, "検査対象エンジンがWindowsビルド記録と一致しません。");
  const result = spawnSync(command, ["--help"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `Windows音声エンジンを起動できません。DLL・VCランタイムを確認してください。\n${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /usage|options/i);
  console.log("PASS: 同梱Windows音声エンジンの実起動を確認しました。");
  if (model || audio) {
    assert.ok(model && audio, "認識試験はモデルと音声の両方が必要です");
    // Match the application's decoding options and its five-minute deadline.
    // Keep diagnostic output for this public test fixture so slow runners are diagnosable.
    const started = performance.now();
    const recognized = spawnSync(command, ["-m", model, "-f", audio, "-l", "en", "-nt", "-ng", "-mc", "0", "-nth", "0.9", "-nf", "-sns"], { encoding: "utf8", timeout: 300_000, windowsHide: true });
    if (recognized.error) throw new Error(`Windows音声認識試験に失敗しました (${Math.round(performance.now() - started)}ms): ${recognized.stderr}`, { cause: recognized.error });
    assert.equal(recognized.status, 0, recognized.stderr || recognized.signal);
    assert.match(recognized.stdout, /ask not what your country can do for you/i);
    console.log(`PASS: Windows音声エンジン(${variant})で固定音声の実文字起こしを確認しました (${Math.round(performance.now() - started)}ms)。`);
    console.log(recognized.stderr.split(/\r?\n/).filter((line) => /timings:/.test(line)).join("\n"));
  }
}

export function testWindowsEnginePair(compatible, optimized, options = {}) {
  // PowerShell 7's .NET checks include the OS AVX state. F16C is CPUID leaf 1 ECX bit 29.
  const probe = spawnSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", "[System.Runtime.Intrinsics.X86.Sse42]::IsSupported -and [System.Runtime.Intrinsics.X86.Avx2]::IsSupported -and [System.Runtime.Intrinsics.X86.Fma]::IsSupported -and (([System.Runtime.Intrinsics.X86.X86Base]::CpuId(1, 0).Item3 -band 536870912) -ne 0)"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
  assert.ifError(probe.error);
  assert.equal(probe.status, 0, probe.stderr);
  assert.match(probe.stdout.trim(), /^(True|False)$/);
  const useOptimized = probe.stdout.trim() === "True";
  testWindowsEngine(compatible, useOptimized ? {} : options);
  if (useOptimized) testWindowsEngine(optimized, { ...options, variant: "avx2" });
  else console.log("INFO: このCPUでは互換エンジンを検査しました。AVX2版は実行していません。");
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const staging = mkdtempSync(join(tmpdir(), "doon-whisper-windows-check-"));
  try {
    // Only the executable is copied: preinstalled build tools must not mask missing sibling DLLs.
    const compatible = join(staging, "whisper-cli.exe");
    const optimized = join(staging, "whisper-avx2.exe");
    copyFileSync(join(root, "src-tauri", "binaries", "whisper-cli-x86_64-pc-windows-msvc.exe"), compatible);
    copyFileSync(join(root, "src-tauri", "resources", "engine", "windows-x64", "whisper", "whisper-avx2.exe"), optimized);
    testWindowsEnginePair(compatible, optimized, { model: process.env.DOON_TEST_MODEL, audio: process.env.DOON_TEST_AUDIO });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
