import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const mimeTypes = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);

function extension(path) {
  const name = basename(path);
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index).toLowerCase();
}

export function renderStandaloneGuide({ htmlPath, cssPath, assetsDirectory, version }) {
  const css = readFileSync(cssPath, "utf8");
  let html = readFileSync(htmlPath, "utf8")
    .replaceAll("{{VERSION}}", version)
    .replace('<link rel="stylesheet" href="doon-voice-install-guide.css" />', `<style>\n${css}\n</style>`);

  html = html.replaceAll(/(?:src|href)="install-guide-assets\/([^"?#]+)"/g, (attribute, filename) => {
    const path = join(assetsDirectory, filename);
    const mimeType = mimeTypes.get(extension(path));
    if (!mimeType) throw new Error(`Capsuleへ内蔵できない画像形式です: ${filename}`);
    const data = readFileSync(path).toString("base64");
    const name = attribute.startsWith("src=") ? "src" : "href";
    return `${name}="data:${mimeType};base64,${data}"`;
  });

  if (html.includes("{{VERSION}}")) throw new Error("Capsule手順書に未置換のバージョン表記が残っています。");
  if (html.includes("install-guide-assets/") || html.includes("doon-voice-install-guide.css")) {
    throw new Error("Capsule手順書に外部ファイル参照が残っています。");
  }
  return html;
}

export function createCapsuleDocument({ outputPath, html, title, version }) {
  if (!/^<!doctype html>/i.test(html.trim())) throw new Error("Capsuleへ保存する完全なHTMLが必要です。");
  const temporaryPath = `${outputPath}.part`;
  rmSync(temporaryPath, { force: true });
  const database = new DatabaseSync(temporaryPath);
  try {
    database.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA user_version = 9;
      CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT) STRICT, WITHOUT ROWID;
      CREATE TABLE app_permissions (permission TEXT PRIMARY KEY, reason TEXT) STRICT, WITHOUT ROWID;
      CREATE TABLE app_ui (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version INTEGER NOT NULL DEFAULT 1,
        html TEXT NOT NULL,
        source_bundle TEXT,
        source_framework TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        is_active INTEGER DEFAULT 1
      ) STRICT;
      CREATE UNIQUE INDEX idx_app_ui_single_active ON app_ui(is_active) WHERE is_active = 1;
      CREATE TABLE doc_records (
        collection TEXT NOT NULL,
        _id TEXT NOT NULL,
        data_json TEXT NOT NULL,
        PRIMARY KEY (collection, _id)
      ) STRICT;
      CREATE TABLE doc_storage (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE app_assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL UNIQUE,
        mime_type TEXT NOT NULL,
        data BLOB NOT NULL,
        size_bytes INTEGER,
        hash_sha256 TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      ) STRICT;
      CREATE TABLE doc_assets (
        id TEXT PRIMARY KEY,
        display_name TEXT,
        belongs_to TEXT,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER,
        hash_sha256 TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX idx_doc_assets_belongs_to ON doc_assets(belongs_to);
      CREATE TABLE doc_asset_blobs (id TEXT PRIMARY KEY, data BLOB NOT NULL) STRICT;
    `);
    const now = new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
    const insertMeta = database.prepare("INSERT INTO app_meta (key, value) VALUES (?, ?)");
    for (const [key, value] of [
      ["app_name", title],
      ["app_version", version],
      ["created_at", now],
      ["icon_blob_id", ""],
      ["schema_version", "9"],
      ["ui_version", "1"],
      ["updated_at", now],
      ["content_sha256", createHash("sha256").update(html).digest("hex")],
    ]) insertMeta.run(key, value);
    database.prepare("INSERT INTO app_ui (version, html, is_active) VALUES (1, ?, 1)").run(html);
  } finally {
    database.close();
  }
  if (!existsSync(temporaryPath)) throw new Error("Capsuleファイルを生成できませんでした。");
  rmSync(outputPath, { force: true });
  renameSync(temporaryPath, outputPath);
}
