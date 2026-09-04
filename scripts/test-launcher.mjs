#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceLauncher = join(projectRoot, "scripts", "launch.mjs");
const temporaryRoot = mkdtempSync(join(tmpdir(), "doon-voice-launcher-test-"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function makeFixture(name) {
  const root = join(temporaryRoot, name);
  const scripts = join(root, "scripts");
  const bin = join(root, "bin");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(bin, { recursive: true });
  copyFileSync(sourceLauncher, join(scripts, "launch.mjs"));
  writeFileSync(join(root, "package-lock.json"), '{"version":1}\n', "utf8");

  if (process.platform === "win32") {
    writeFileSync(join(bin, "npm.cmd"), [
      "@echo off",
      "echo %*>>\"%FAKE_NPM_LOG%\"",
      "if \"%2\"==\"setup\" exit /b %FAKE_SETUP_EXIT%",
      "exit /b %FAKE_APP_EXIT%",
      "",
    ].join("\r\n"), "utf8");
  } else {
    const fakeNpm = join(bin, "npm");
    writeFileSync(fakeNpm, [
      "#!/bin/sh",
      "printf '%s\\n' \"$*\" >> \"$FAKE_NPM_LOG\"",
      "if [ \"$2\" = \"setup\" ]; then exit \"$FAKE_SETUP_EXIT\"; fi",
      "exit \"$FAKE_APP_EXIT\"",
      "",
    ].join("\n"), "utf8");
    chmodSync(fakeNpm, 0o755);
  }

  return { root, log: join(root, "npm.log"), launcher: join(scripts, "launch.mjs") };
}

function run(fixture, args = [], overrides = {}) {
  return spawnSync(process.execPath, [fixture.launcher, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(fixture.root, "bin")}${delimiter}${process.env.PATH ?? ""}`,
      FAKE_NPM_LOG: fixture.log,
      FAKE_SETUP_EXIT: "0",
      FAKE_APP_EXIT: "0",
      ...overrides,
    },
  });
}

try {
  const normal = makeFixture("normal");
  const first = run(normal, ["--setup-only"]);
  assert(first.status === 0, `初回セットアップが失敗しました: ${first.stderr}`);
  assert(readFileSync(normal.log, "utf8").trim().split("\n").length === 1, "初回はセットアップを1回だけ実行する");

  const second = run(normal, ["--setup-only"]);
  assert(second.status === 0, `2回目の起動確認が失敗しました: ${second.stderr}`);
  assert(readFileSync(normal.log, "utf8").trim().split("\n").length === 1, "2回目はセットアップを省略する");

  writeFileSync(join(normal.root, "package-lock.json"), '{"version":2}\n', "utf8");
  const dependencyChanged = run(normal, ["--setup-only"]);
  assert(dependencyChanged.status === 0, `依存変更後のセットアップが失敗しました: ${dependencyChanged.stderr}`);
  assert(readFileSync(normal.log, "utf8").trim().split("\n").length === 2, "依存変更後はセットアップをやり直す");

  const appFailure = run(normal, [], { FAKE_APP_EXIT: "9" });
  assert(appFailure.status === 9, "アプリ起動の終了コードを呼び出し元へ返す");

  const failedSetup = makeFixture("failed-setup");
  const setupFailure = run(failedSetup, ["--setup-only"], { FAKE_SETUP_EXIT: "7" });
  assert(setupFailure.status === 7, "セットアップ失敗の終了コードを呼び出し元へ返す");
  assert(!existsSync(join(failedSetup.root, "node_modules", ".doon-voice-setup.json")), "失敗したセットアップを完了扱いにしない");

  console.log("PASS: ダブルクリック起動の初回・再実行・失敗時動作を検証しました");
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
