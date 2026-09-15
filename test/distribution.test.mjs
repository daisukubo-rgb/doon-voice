import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { installerArch, selectInstaller } from "../scripts/package-installer-zip.mjs";
import { npmInvocation, runNpm } from "../scripts/npm-runner.mjs";
import { verifyLicenses } from "../scripts/check-licenses.mjs";

const project = resolve(fileURLToPath(new URL("..", import.meta.url)));
const version = JSON.parse(readFileSync(join(project, "package.json"), "utf8")).version;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "doon distribution & spaces "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(join(project, "scripts"), join(root, "scripts"), { recursive: true });
  cpSync(join(project, "docs"), join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "src-tauri"), { recursive: true });
  copyFileSync(join(project, "src-tauri", "tauri.conf.json"), join(root, "src-tauri", "tauri.conf.json"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "distribution-fixture", version, private: true }));
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({ name: "distribution-fixture", version, lockfileVersion: 3, requires: true, packages: { "": { name: "distribution-fixture", version } } }));
  return root;
}

test("macOS同梱エンジンは配布時のHardened Runtime署名後も起動する", { skip: process.platform !== "darwin" }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "doon signed engine "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const architecture = process.arch === "arm64" ? "aarch64" : "x86_64";
  const platform = process.arch === "arm64" ? "macos-arm64" : "macos-x64";
  const executable = join(root, "Contents", "MacOS", "whisper-cli");
  const libraries = join(root, "Contents", "Resources", "engine", platform, "whisper");
  mkdirSync(join(root, "Contents", "MacOS"), { recursive: true });
  copyFileSync(join(project, "src-tauri", "binaries", `whisper-cli-${architecture}-apple-darwin`), executable);
  cpSync(join(project, "src-tauri", "resources", "engine", platform, "whisper"), libraries, { recursive: true });
  const signed = spawnSync("codesign", ["--force", "--sign", "-", "--options", "runtime", executable], { encoding: "utf8", timeout: 10_000 });
  assert.equal(signed.status, 0, signed.error?.message || signed.stderr);
  const result = spawnSync(executable, ["--help"], { cwd: libraries, env: { ...process.env, DYLD_LIBRARY_PATH: libraries }, encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.signal);
  assert.match(result.stdout + result.stderr, /--model/);
});

test("実セットアップはnpmのJavaScriptエントリーをNodeで実行する", (t) => {
  const root = fixture(t);
  const npmCli = join(root, "npm-cli.js");
  const log = join(root, "npm-args.json");
  writeFileSync(npmCli, `require('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));`);
  const result = spawnSync(process.execPath, [join(root, "scripts", "setup.mjs")], {
    cwd: root, encoding: "utf8", env: { ...process.env, npm_execpath: npmCli },
  });
  assert.equal(existsSync(log), true, `選ばれたnpm CLIが実行されていません: ${result.stderr}`);
  assert.deepEqual(JSON.parse(readFileSync(log, "utf8")), ["ci"]);
});

test("実セットアップから実npm ciを実行できる（Windowsを含む）", (t) => {
  const root = fixture(t);
  const result = spawnSync(process.execPath, [join(root, "scripts", "setup.mjs")], {
    cwd: root, encoding: "utf8", env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /up to date|added \d+ packages/);
});

const supported = ["darwin", "win32"].includes(process.platform);
const ext = process.platform === "darwin" ? ".dmg" : ".msi";
const arch = process.platform === "darwin" ? (process.arch === "arm64" ? "aarch64" : "x64") : "x64";
const installerName = (v, a = arch, prefix = "DOON Voice") => `${prefix}_${v}_${a}${process.platform === "win32" ? "_en-US" : ""}${ext}`;

function packageFixture(t, names) {
  const root = fixture(t);
  const bundle = join(root, "src-tauri", "target", "release", "bundle", ext === ".dmg" ? "dmg" : "msi");
  mkdirSync(bundle, { recursive: true });
  for (const name of names) writeFileSync(join(bundle, name), "synthetic installer");
  const result = spawnSync(process.execPath, [join(root, "scripts", "package-installer-zip.mjs")], {
    cwd: root, encoding: "utf8", env: { ...process.env, TAURI_TARGET: "", DOON_VOICE_PACKAGE_SUFFIX: "Test" },
  });
  return { root, result };
}

test("旧版と別archが残っていても現version/archだけを梱包する", { skip: !supported }, (t) => {
  const old = installerName("0.0.1");
  const current = installerName(version);
  const other = installerName(version, arch === "x64" ? "aarch64" : "x64");
  const { root, result } = packageFixture(t, [old, current, other]);
  assert.equal(result.status, 0, result.stderr);
  const zip = join(root, "dist", "DOON Voice-Test.zip");
  const listing = process.platform === "darwin"
    ? spawnSync("unzip", ["-Z1", zip], { encoding: "utf8" })
    : spawnSync("powershell.exe", ["-NoProfile", "-Command", "Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::OpenRead($env.TEST_ZIP).Entries.FullName"], { encoding: "utf8", env: { ...process.env, TEST_ZIP: zip } });
  assert.equal(listing.status, 0, listing.stderr);
  assert.ok(listing.stdout.includes(current), listing.stdout);
  assert.ok(!listing.stdout.includes(old), listing.stdout);
  assert.ok(!listing.stdout.includes(other), listing.stdout);
});

test("現version/archの候補がなければ旧版を代用せず失敗する", { skip: !supported }, (t) => {
  const { result } = packageFixture(t, [installerName("0.0.1")]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /見つかりません|一致する/);
});

test("現version/archの候補が複数なら曖昧なZIPを作らない", { skip: !supported }, (t) => {
  const { result } = packageFixture(t, [installerName(version), installerName(version, arch, "DOON.Voice")]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /複数|曖昧/);
});

test("実依存の著作権とライセンス全文が収録されアプリ同梱対象になっている", () => {
  const notices = readFileSync(join(project, "docs", "OSS-NOTICES.md"), "utf8");
  const lucide = readFileSync(join(project, "node_modules", "lucide-react", "LICENSE"), "utf8").trim();
  const material = join(project, "docs", "licenses", "npm", "lucide-react", "LICENSE");
  assert.ok(existsSync(material), "Lucideの実LICENSEファイルがありません");
  assert.equal(readFileSync(material, "utf8").trim(), lucide);
  assert.ok(existsSync(join(project, "docs", "licenses", "inventory.json")), "バージョン付き依存一覧がありません");
  assert.match(notices, /licenses/);
  const config = JSON.parse(readFileSync(join(project, "src-tauri", "tauri.conf.json"), "utf8"));
  assert.equal(config.bundle.resources["../docs/licenses"], "licenses");
  const cpal = readFileSync(join(project, "docs", "licenses", "cargo", "cpal-0.16.0", "LICENSE"), "utf8");
  assert.match(cpal, /Apache License/);
  assert.match(cpal, /END OF TERMS AND CONDITIONS/);
  assert.ok(verifyLicenses(join(project, "docs"), true) > 0);
});

test("npm runnerはWindowsでもNodeを選び、記号入りの引数をそのまま渡す", (t) => {
  const root = fixture(t);
  const entry = join(root, "npm-cli.cjs");
  writeFileSync(entry, "console.log(JSON.stringify(process.argv.slice(2)));");
  const env = { ...process.env, npm_execpath: entry };
  assert.deepEqual(npmInvocation({ env, platform: "win32" }), { command: process.execPath, args: [realpathSync(entry)] });
  const args = ["run", "task & echo injected", "$(echo injected)", "quote'\" space"];
  const result = runNpm(args, { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);
});

test("npm実行ファイルが見つからないと具体的な原因を返す", () => {
  assert.throws(() => npmInvocation({ env: {}, execPath: "/definitely-missing/node.exe", platform: "win32" }), /npm.*見つかりません/);
});

test("Windows梱包はversion/archを照合しMSIとNSISの曖昧さも拒否する", (t) => {
  const root = fixture(t);
  const directory = join(root, "bundle");
  mkdirSync(join(directory, "msi"), { recursive: true });
  mkdirSync(join(directory, "nsis"));
  writeFileSync(join(directory, "msi", `DOON Voice_${version}_arm64_en-US.msi`), "other arch");
  const expected = join(directory, "msi", `DOON Voice_${version}_x64_en-US.msi`);
  writeFileSync(expected, "current");
  const options = { directory, productName: "DOON Voice", version, platform: "win32", arch: "x64" };
  assert.equal(selectInstaller(options), expected);
  writeFileSync(join(directory, "nsis", `DOON Voice_${version}_x64_setup.exe`), "second current");
  assert.throws(() => selectInstaller(options), /複数/);
  assert.equal(installerArch("darwin", "x86_64-apple-darwin", "arm64"), "x64");
  assert.throws(() => installerArch("darwin", "x86_64-pc-windows-msvc", "arm64"), /一致しません/);
  assert.throws(() => installerArch("win32", "", "ia32"), /未対応/);
});

test("同梱LICENSEの欠落や改変をハッシュ検査で拒否する", (t) => {
  const root = fixture(t);
  const docs = join(root, "docs");
  const license = join(docs, "licenses", "npm", "lucide-react", "LICENSE");
  writeFileSync(license, "license removed");
  assert.throws(() => verifyLicenses(docs), /原文が一致しません/);
  rmSync(license);
  assert.throws(() => verifyLicenses(docs), /ENOENT/);
});

test("配布内の音声エンジンも来歴一覧と照合し、別binaryへの差し替えを拒否する", (t) => {
  const root = fixture(t);
  const docs = join(root, "docs");
  cpSync(join(project, "src-tauri", "resources", "engine"), join(docs, "engine"), { recursive: true });
  assert.ok(verifyLicenses(docs) > 0);
  const manifest = JSON.parse(readFileSync(join(docs, "licenses", "engine-inventory.json"), "utf8"));
  const entry = manifest.files.find((file) => file.path.startsWith("src-tauri/resources/"));
  writeFileSync(join(docs, entry.path.slice("src-tauri/resources/".length)), "unexpected binary");
  assert.throws(() => verifyLicenses(docs), /同梱エンジンが記録と一致しません/);
});

test("CIはテストとランチャーの変更を検査しReleaseは対象タグの全検査後に公開する", () => {
  const ci = readFileSync(join(project, ".github", "workflows", "ci.yml"), "utf8");
  const release = readFileSync(join(project, ".github", "workflows", "release.yml"), "utf8");
  for (const path of ["test/**", "DOON Voiceを起動.command", "DOON Voiceを起動.bat"]) assert.equal(ci.split(`"${path}"`).length - 1, 2);
  assert.ok(!ci.includes("--no-run"));
  assert.match(ci, /node scripts\/setup\.mjs/);
  assert.match(release, /refs\/tags\/\$RELEASE_TAG\^\{commit\}/);
  assert.match(release, /ref: \$\{\{ needs\.resolve\.outputs\.commit \}\}/);
  assert.match(release, /needs: \[resolve, quality\]/);
  assert.match(release, /needs: \[resolve, package\]/);
  assert.match(release, /- run: npm test/);
  assert.match(release, /node scripts\/verify-installer-licenses\.mjs/);
  assert.match(release, /node scripts\/test-windows-engine\.mjs/);
});
