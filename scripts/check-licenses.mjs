#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const hash = (data) => createHash("sha256").update(data).digest("hex");

export function verifyLicenses(resources = join(root, "docs"), checkSources = false) {
  const material = join(resources, "licenses");
  const inventory = JSON.parse(readFileSync(join(material, "inventory.json"), "utf8"));
  if (inventory.schema !== 1 || inventory.packages.length === 0) throw new Error("依存一覧が空または未対応です。");
  if (!existsSync(join(resources, "OSS-NOTICES.md"))) throw new Error("OSS表示が同梱されていません。");
  if (!inventory.engineManifest || hash(readFileSync(join(material, inventory.engineManifest.path))) !== inventory.engineManifest.sha256) throw new Error("エンジン一覧が一致しません。");
  for (const pkg of inventory.packages) {
    if (!pkg.files?.length) throw new Error(`${pkg.name}: ライセンス原文がありません。`);
    for (const file of pkg.files) {
      const path = resolve(material, file.path);
      const relativePath = relative(material, path);
      if (relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error("ライセンスのパスが保存先外です。");
      if (hash(readFileSync(path)) !== file.sha256) throw new Error(`${pkg.name}: ${file.path} の原文が一致しません。`);
    }
  }
  const engines = JSON.parse(readFileSync(join(material, "engine-inventory.json"), "utf8"));
  if (existsSync(join(resources, "engine"))) {
    for (const file of engines.files.filter((file) => file.path.startsWith("src-tauri/resources/"))) {
      const bundled = join(resources, file.path.slice("src-tauri/resources/".length));
      if (hash(readFileSync(bundled)) !== file.sha256) throw new Error(`${file.path}: 同梱エンジンが記録と一致しません。`);
    }
  }
  if (checkSources) {
    for (const file of engines.files) {
      if (hash(readFileSync(join(root, file.path))) !== file.sha256) throw new Error(`${file.path}: エンジン変更後の由来・表示の再確認が必要です。`);
    }
    for (const [file, checksum] of Object.entries(inventory.locks)) {
      if (hash(readFileSync(join(root, file))) !== checksum) throw new Error(`${file} が変わりました。node scripts/collect-licenses.mjs を実行してください。`);
    }
    const installed = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    for (const [path, pkg] of Object.entries(installed.packages).filter(([path, pkg]) => path && !pkg.dev)) {
      const name = JSON.parse(readFileSync(join(root, path, "package.json"), "utf8")).name;
      if (!inventory.packages.some((item) => item.ecosystem === "npm" && item.name === name && item.version === pkg.version)) throw new Error(`${name}: バージョンに対応する表示がありません。`);
    }
  }
  return inventory.packages.length;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const count = verifyLicenses(process.argv[2] ? resolve(process.argv[2]) : join(root, "docs"), !process.argv[2]);
  console.log(`PASS: ${count}件のライセンス資料とハッシュを確認しました。許諾・出所の確認事項はOSS-NOTICES.mdを参照してください。`);
}
