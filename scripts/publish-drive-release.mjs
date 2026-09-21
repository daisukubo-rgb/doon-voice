#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function versionFromFolder(name, prefix) {
  const match = name.match(new RegExp(`^${prefix}（v(\\d+\\.\\d+\\.\\d+)）$`));
  return match?.[1];
}

function moveContents(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const name of readdirSync(source)) renameSync(join(source, name), join(destination, name));
  rmdirSync(source);
}

function requireFile(directory, name) {
  const names = [name, name.replace("DOON Voice", "DOON.Voice")];
  for (const candidate of names) {
    const path = join(directory, candidate);
    if (existsSync(path) && statSync(path).isFile()) return path;
  }
  throw new Error(`配布ファイルがありません: ${join(directory, name)}`);
}

export function publishDriveRelease({ sourceDirectory, driveRoot, version }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`バージョンが不正です: ${version}`);
  const packages = [
    ["DOON Voice-macOS.zip", `DOON Voice-macOS-v${version}.zip`],
    ["DOON Voice-macOS-Intel.zip", `DOON Voice-macOS-Intel-v${version}.zip`],
    ["DOON Voice-Windows.zip", `DOON Voice-Windows-v${version}.zip`],
  ];
  const updates = [
    `DOON Voice-update-${version}-macos-aarch64.tar.gz`,
    `DOON Voice-update-${version}-macos-aarch64.tar.gz.sig`,
    `DOON Voice-update-${version}-macos-x86_64.tar.gz`,
    `DOON Voice-update-${version}-macos-x86_64.tar.gz.sig`,
    `DOON Voice-update-${version}-windows-x86_64.msi`,
    `DOON Voice-update-${version}-windows-x86_64.msi.sig`,
  ];
  for (const [name] of packages) requireFile(sourceDirectory, name);
  for (const name of updates) requireFile(sourceDirectory, name);

  mkdirSync(driveRoot, { recursive: true });
  const previousLatest = readdirSync(driveRoot).find((name) => versionFromFolder(name, "01_最新版"));
  if (previousLatest) {
    const previousVersion = versionFromFolder(previousLatest, "01_最新版");
    if (previousVersion !== version) moveContents(join(driveRoot, previousLatest), join(driveRoot, "02_過去バージョン", `v${previousVersion}`));
  }
  const updaterRoot = join(driveRoot, "03_自動更新用");
  mkdirSync(join(updaterRoot, "過去"), { recursive: true });
  const previousUpdater = readdirSync(updaterRoot).find((name) => versionFromFolder(name, "最新版"));
  if (previousUpdater) {
    const previousVersion = versionFromFolder(previousUpdater, "最新版");
    if (previousVersion !== version) moveContents(join(updaterRoot, previousUpdater), join(updaterRoot, "過去", `v${previousVersion}`));
  }

  const latest = join(driveRoot, `01_最新版（v${version}）`);
  const latestUpdater = join(updaterRoot, `最新版（v${version}）`);
  mkdirSync(latest, { recursive: true });
  mkdirSync(latestUpdater, { recursive: true });
  for (const [source, destination] of packages) copyFileSync(requireFile(sourceDirectory, source), join(latest, destination));
  for (const name of updates) copyFileSync(requireFile(sourceDirectory, name), join(latestUpdater, name));
  return { latest, latestUpdater };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [sourceDirectory, version] = process.argv.slice(2);
  const driveRoot = process.env.DOON_VOICE_DRIVE_ROOT;
  if (!sourceDirectory || !version || !driveRoot) {
    throw new Error("使い方: DOON_VOICE_DRIVE_ROOT=... node scripts/publish-drive-release.mjs <配布ファイルのフォルダ> <version>");
  }
  const result = publishDriveRelease({ sourceDirectory: resolve(sourceDirectory), driveRoot: resolve(driveRoot), version });
  console.log(`最新版を整理しました: ${result.latest}`);
  console.log(`自動更新用を整理しました: ${result.latestUpdater}`);
}
