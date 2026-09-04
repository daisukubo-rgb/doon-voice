import { readFileSync } from "node:fs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const ossNotices = readFileSync(new URL("../docs/OSS-NOTICES.md", import.meta.url), "utf8");
const tauriConfig = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));

for (const font of ["Inter", "Roboto"]) {
  assert(!styles.includes(`\"${font}\"`), `${font}をUIフォントに使わない`);
}

for (const color of ["#f5f1e8", "#fffaf0", "#f2eadb", "#e8dfcf", "#d8cfbd"]) {
  assert(!styles.toLowerCase().includes(color), `DOON Voiceで生成り系カラー ${color} を使わない`);
}
assert(!styles.includes("255, 250, 240"), "半透明色にも生成り系カラーを残さない");

assert(app.includes("BrandGlyph"), "DOON独自絵柄をブランド表現として維持する");
assert(app.includes("/brand/icons/doon-glyph-"), "DOON独自絵柄の参照を維持する");
assert(/\.voice-overlay\s*\{[^}]*border-radius:\s*8px;/s.test(styles), "状態オーバーレイの角丸は8px以下にする");
assert(/@media \(max-width: 760px\)[\s\S]*?\.voice-stage h1\s*\{[^}]*white-space:\s*nowrap;/s.test(styles), "スマホ見出しで末尾1文字を孤立改行させない");
assert(app.includes("<em>AIで</em>言語化をイージーに"), "ホーム見出しを指定コピーにする");
assert(styles.includes('font-family: "RocknRoll One"'), "ホーム見出しにロゴ感のある日本語書体を使う");
assert(main.includes('@fontsource/rocknroll-one/400.css'), "RocknRoll Oneを配布物へ同梱する");
assert(ossNotices.includes("SIL OPEN FONT LICENSE Version 1.1"), "同梱フォントのOFL-1.1全文をOSS表示へ含める");
assert(
  tauriConfig.app.windows[0]?.backgroundThrottling === "disabled",
  "本体が背面・最小化中でもショートカット後の録音とAI処理を止めない",
);
assert(!app.includes('listen("doon-voice-shortcut"'), "グローバルショートカットの実処理をWebViewに依存させない");
assert(app.includes('appInvoke("toggle_background_voice")'), "本体の録音ボタンも常駐ランタイムを使う");
assert(app.includes('appInvoke("configure_background_voice"'), "選択AIと辞書を常駐ランタイムへ同期する");
assert(!app.includes('label: "接続済み"'), "CLIログインだけを接続済みと誤表示しない");
assert(app.includes('label: "ログイン済み"'), "公式CLIの認証状態はログイン済みと正確に表示する");
assert(app.includes('label: "利用可能"'), "実際の整形成功後は利用可能と表示する");
assert(app.includes('label: "利用不可"'), "契約などで実行できないAIは利用不可と表示する");
assert(app.includes("connectedProviders"), "DOON Voice内でログインしたAIをサービス別に記憶する");
assert(
  app.includes("connectedProviders[id] && statuses[id]?.authenticated"),
  "別サービスのCLI認証をDOON Voiceの接続済み状態へ流用しない",
);
assert(
  app.includes("({ ...current, [provider]: true })"),
  "ログイン完了時は操作したサービスだけを接続済みにする",
);
assert(app.includes('type ProviderId = "codex" | "claude" | "gemini"'), "Geminiの接続状態を他AIと分離する");
assert(app.includes("Gemini 3.6 Flash (Low)"), "Geminiの文章整形はFlash Lowへ固定する");

console.info("PASS: UI制作規約v1.1の静的契約を検証しました");
