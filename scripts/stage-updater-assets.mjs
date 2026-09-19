#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(fileURLToPath(new URL("..", import.meta.url)));

function onlyFile(directory, predicate, label) {
  const matches = existsSync(directory)
    ? readdirSync(directory).filter((name) => predicate(name)).map((name) => join(directory, name))
    : [];
  if (matches.length !== 1) throw new Error(`${label}は1件必要です。検出: ${matches.map(basename).join("、") || "0件"}`);
  return matches[0];
}

export function stageUpdaterAssets({ root = project, target = process.env.TAURI_TARGET } = {}) {
  if (!target) throw new Error("TAURI_TARGETを指定してください。");
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const bundle = join(root, "src-tauri", "target", target, "release", "bundle");
  const output = join(root, "dist", "updater");
  mkdirSync(output, { recursive: true });

  let source;
  let destinationName;
  if (target === "aarch64-apple-darwin" || target === "x86_64-apple-darwin") {
    source = onlyFile(join(bundle, "macos"), (name) => name.endsWith(".tar.gz"), "macOS更新ファイル");
    const architecture = target.startsWith("aarch64") ? "aarch64" : "x86_64";
    destinationName = `DOON Voice-update-${version}-macos-${architecture}.tar.gz`;
  } else if (target === "x86_64-pc-windows-msvc") {
    source = onlyFile(join(bundle, "msi"), (name) => name.endsWith(".msi") && name.includes(`_${version}_x64`), "Windows更新ファイル");
    destinationName = `DOON Voice-update-${version}-windows-x86_64.msi`;
  } else {
    throw new Error(`未対応の更新対象です: ${target}`);
  }

  const signature = `${source}.sig`;
  if (!existsSync(signature)) throw new Error(`署名がありません: ${signature}`);
  const destination = join(output, destinationName);
  copyFileSync(source, destination);
  copyFileSync(signature, `${destination}.sig`);
  return [destination, `${destination}.sig`];
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  for (const path of stageUpdaterAssets()) console.log(`更新配布へ追加しました: ${path}`);
}
