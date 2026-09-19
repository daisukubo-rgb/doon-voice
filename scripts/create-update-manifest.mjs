#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function filesBelow(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesBelow(path) : [path];
  });
}

export function createUpdateManifest({ artifactsDirectory, outputPath, repository, tag, publishedAt = new Date().toISOString() }) {
  if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) throw new Error("GitHubの owner/repository を指定してください。");
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`リリースタグが不正です: ${tag}`);
  const version = tag.slice(1);
  const files = filesBelow(artifactsDirectory);
  const specifications = [
    ["darwin-aarch64", `DOON Voice-update-${version}-macos-aarch64.tar.gz`],
    ["darwin-x86_64", `DOON Voice-update-${version}-macos-x86_64.tar.gz`],
    ["windows-x86_64", `DOON Voice-update-${version}-windows-x86_64.msi`],
  ];
  const platforms = {};
  for (const [platform, filename] of specifications) {
    const asset = files.filter((path) => basename(path) === filename);
    if (asset.length !== 1) throw new Error(`${filename}は1件必要です。検出: ${asset.length}件`);
    const signature = `${asset[0]}.sig`;
    if (!existsSync(signature)) throw new Error(`署名がありません: ${signature}`);
    // GitHub Release replaces spaces in uploaded asset names with periods.
    const releaseFilename = filename.replaceAll(" ", ".");
    platforms[platform] = {
      url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(releaseFilename)}`,
      signature: readFileSync(signature, "utf8").trim(),
    };
  }
  const manifest = {
    version,
    notes: `DOON Voice ${version}。アプリ内の更新ボタンから適用できます。`,
    pub_date: publishedAt,
    platforms,
  };
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [artifactsDirectory = "installers", outputPath = "latest.json"] = process.argv.slice(2);
  createUpdateManifest({
    artifactsDirectory: resolve(artifactsDirectory),
    outputPath: resolve(outputPath),
    repository: process.env.GITHUB_REPOSITORY,
    tag: process.env.RELEASE_TAG,
  });
  console.log(`自動更新マニフェストを作成しました: ${resolve(outputPath)}`);
}
