#!/usr/bin/env node
// Regenerate the checked-in license snapshot from installed, locked sources.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = join(root, "docs", "licenses");
const hash = (data) => createHash("sha256").update(data).digest("hex");
const fetchSource = (url) => fetch(url, { signal: AbortSignal.timeout(120_000) });
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const licenseName = /^(licen[sc]e|notice|copyright|copying)(s|[._-].*)?$/i;
const inventory = { schema: 1, locks: {}, packages: [], reviewNotes: [] };

function licenseFiles(directory, prefix = "") {
  return readdirSync(join(directory, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = join(prefix, entry.name);
    if (entry.isFile() && licenseName.test(entry.name)) return [path];
    if (entry.isDirectory() && !["node_modules", ".git", "target"].includes(entry.name)) return licenseFiles(directory, path);
    return [];
  }).sort();
}

function storeFile(path, data, source) {
  mkdirSync(dirname(join(output, path)), { recursive: true });
  writeFileSync(join(output, path), data);
  return { path: path.replaceAll("\\", "/"), sha256: hash(data), source };
}

const trees = new Map();
async function upstreamFiles(pkg, directory) {
  if (pkg.name === "sigchld" && pkg.version === "0.2.4") {
    inventory.reviewNotes.push({ name: pkg.name, version: pkg.version, issue: "公開crateと固定commitのリポジトリにLICENSE本文・著作権表示がなく、Cargo.tomlのMIT宣言のみを収録。権利者確認が必要。" });
    return [{ path: "LICENSE-DECLARATION.toml", source: `https://crates.io/api/v1/crates/sigchld/${pkg.version}/download#Cargo.toml.orig`, data: readFileSync(join(directory, "Cargo.toml.orig")) }];
  }
  if (pkg.name === "selectors" && pkg.license === "MPL-2.0") {
    const source = "https://www.mozilla.org/media/MPL/2.0/index.txt";
    const response = await fetchSource(source);
    if (!response.ok) throw new Error("Cannot fetch the MPL 2.0 text referenced by selectors/lib.rs");
    return [
      { path: "LICENSE-MPL-2.0", source, data: Buffer.from(await response.arrayBuffer()) },
      { path: "SOURCE-NOTICE.txt", source: `https://crates.io/api/v1/crates/selectors/${pkg.version}/download#lib.rs`, data: readFileSync(join(directory, "lib.rs")) },
    ];
  }
  const vcsPath = join(directory, ".cargo_vcs_info.json");
  if (!existsSync(vcsPath)) throw new Error(`${pkg.name}: source revision is missing`);
  const vcs = json(vcsPath);
  // dasp_sample retains its old repository URL in the published manifest.
  const repoUrl = pkg.name === "dasp_sample" ? "https://github.com/RustAudio/dasp" : pkg.repository;
  const match = repoUrl?.replace(/\.git\/?$/, "").match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/?$/);
  if (!match) throw new Error(`${pkg.name}: upstream license needs review`);
  const repo = match[1];
  const revision = vcs.git.sha1;
  const key = `${repo}/${revision}`;
  if (!trees.has(key)) {
    const response = await fetchSource(`https://api.github.com/repos/${repo}/git/trees/${revision}?recursive=1`);
    if (!response.ok) throw new Error(`${pkg.name}: cannot read source tree (${response.status})`);
    trees.set(key, await response.json());
  }
  const tree = trees.get(key);
  if (tree.truncated) throw new Error(`${pkg.name}: source tree is truncated`);
  const ancestors = new Set(["."]);
  let location = vcs.path_in_vcs || ".";
  while (location !== ".") { ancestors.add(location); location = dirname(location); }
  const paths = tree.tree.filter((entry) => entry.type === "blob" && licenseName.test(entry.path.split("/").at(-1)) && ancestors.has(dirname(entry.path))).map((entry) => entry.path);
  if (paths.length === 0) throw new Error(`${pkg.name}: no original license found at pinned source ${key}`);
  return await Promise.all(paths.map(async (path) => {
    const source = `https://raw.githubusercontent.com/${repo}/${revision}/${path}`;
    const response = await fetchSource(source);
    if (!response.ok) throw new Error(`${pkg.name}: cannot download ${source}`);
    return { path, source, data: Buffer.from(await response.arrayBuffer()) };
  }));
}

const lock = json(join(root, "package-lock.json"));
for (const [path, pkg] of Object.entries(lock.packages).filter(([path, pkg]) => path && !pkg.dev)) {
  const directory = join(root, path);
  const info = json(join(directory, "package.json"));
  if (info.version !== pkg.version) throw new Error(`npm version mismatch: ${path}`);
  const paths = licenseFiles(directory);
  if (!paths.length) throw new Error(`npm license missing: ${path}`);
  inventory.packages.push({ ecosystem: "npm", name: info.name, version: info.version, license: info.license, files: paths.map((file) => storeFile(join("npm", info.name, file), readFileSync(join(directory, file)), `${pkg.resolved}#${file}`)) });
}

const packages = new Map();
for (const target of ["aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-pc-windows-msvc"]) {
  const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--locked", "--format-version", "1", "--filter-platform", target], { cwd: join(root, "src-tauri"), encoding: "utf8", maxBuffer: 30 * 1024 * 1024 }));
  for (const pkg of metadata.packages.filter((pkg) => pkg.source)) packages.set(`${pkg.name}@${pkg.version}`, pkg);
}
for (const pkg of [...packages.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))) {
  const directory = dirname(pkg.manifest_path);
  const paths = licenseFiles(directory);
  const files = paths.length
    ? paths.map((path) => ({ path, data: readFileSync(join(directory, path)), source: `https://crates.io/api/v1/crates/${pkg.name}/${pkg.version}/download#${path.replaceAll("\\", "/")}` }))
    : await upstreamFiles(pkg, directory);
  inventory.packages.push({ ecosystem: "cargo", name: pkg.name, version: pkg.version, license: pkg.license, files: files.map((file) => storeFile(join("cargo", `${pkg.name}-${pkg.version}`, file.path), file.data, file.source)) });
}
const engineSources = [
  { name: "whisper.cpp / ggml / parakeet", version: "1.9.2", license: "MIT", path: "whisper.cpp-1.9.2/LICENSE", url: "https://raw.githubusercontent.com/ggml-org/whisper.cpp/v1.9.2/LICENSE" },
  { name: "SDL2", version: "2.28.5", license: "Zlib", path: "SDL2-2.28.5/LICENSE.txt", url: "https://raw.githubusercontent.com/libsdl-org/SDL/release-2.28.5/LICENSE.txt" },
  { name: "Microsoft Visual C++ Runtime reference terms", version: "2015-2022", license: "LicenseRef-Microsoft-Visual-C-Runtime", path: "microsoft/Visual-C-Runtime-2015-2022-License.docx", url: "https://visualstudio.microsoft.com/wp-content/uploads/2021/09/Visual-C-Runtime-2015-2022-License-1.docx" },
];
for (const source of engineSources) {
  const response = await fetchSource(source.url);
  if (!response.ok) throw new Error(`Cannot collect ${source.name} original terms: ${response.status}`);
  const file = storeFile(join("engine", source.path), Buffer.from(await response.arrayBuffer()), source.url);
  inventory.packages.push({ ecosystem: "engine", name: source.name, version: source.version, license: source.license, files: [file] });
}
inventory.reviewNotes.push({ name: "Microsoft Visual C++ Runtime", issue: "同梱済みDLLの由来と適用条件は未確認。公式2015-2022条項原本は確認用資料として収録し、全DLLへの適用や再配布許諾の確認済み表示とはしない。" });
function engineFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? engineFiles(join(directory, entry.name)) : entry.isFile() ? [join(directory, entry.name)] : []);
}
const binaryInventory = engineFiles(join(root, "src-tauri", "resources", "engine")).concat(engineFiles(join(root, "src-tauri", "binaries"))).map((path) => ({ path: relative(root, path).replaceAll("\\", "/"), sha256: hash(readFileSync(path)) })).sort((a, b) => a.path.localeCompare(b.path));
const archiveUrl = "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip";
const temporary = mkdtempSync(join(tmpdir(), "doon-engine-provenance-"));
try {
  const response = await fetchSource(archiveUrl);
  if (!response.ok) throw new Error(`Cannot verify upstream Windows engine: ${response.status}`);
  const archive = join(temporary, "whisper-bin-x64.zip");
  writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  for (const file of binaryInventory) {
    const name = file.path.split("/").at(-1);
    const entry = file.path.endsWith("binaries/whisper-cli-x86_64-pc-windows-msvc.exe") ? "whisper-cli.exe"
      : file.path.includes("engine/windows-x64/") && /^(ggml|whisper|parakeet|SDL2)/.test(name) ? name : null;
    if (!entry) continue;
    const original = execFileSync("tar", ["-xOf", archive, `Release/${entry}`], { maxBuffer: 30 * 1024 * 1024 });
    if (hash(original) !== file.sha256) throw new Error(`${file.path}: pinned upstream binary differs; review engine provenance before updating notices`);
    file.source = `${archiveUrl}#Release/${entry}`;
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
const engineManifest = { source: "https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.2", sourceNotes: "Windowsのwhisper/ggml/parakeet/SDL2は公式whisper-bin-x64.zipとSHA-256一致を確認。SDL2はPEバージョン2.28.5と上流release workflowが一致。MSVC DLLは同ZIPには含まれず出所確認が残る。macOS静的エンジンの固定ソース・ビルド条件・ハッシュはsrc-tauri/resources/engine/macos-build.jsonに記録。旧同梱dylibは静的エンジンでは使用しない。", files: binaryInventory };
const engineManifestData = `${JSON.stringify(engineManifest, null, 2)}\n`;
inventory.engineManifest = storeFile("engine-inventory.json", engineManifestData, "repository bundled engine files");
for (const path of ["package-lock.json", "src-tauri/Cargo.lock"]) inventory.locks[path] = hash(readFileSync(join(root, path)));
mkdirSync(output, { recursive: true });
writeFileSync(join(output, "inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`);
console.log(`Collected license material for ${inventory.packages.length} components into ${relative(root, output)} (${inventory.reviewNotes.length} items need rights/source review)`);
