import { readFileSync } from "node:fs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const backend = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const buildScript = readFileSync(new URL("../src-tauri/build.rs", import.meta.url), "utf8");
const ossNotices = readFileSync(new URL("../docs/OSS-NOTICES.md", import.meta.url), "utf8");
const tauriConfig = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const defaultCapability = JSON.parse(readFileSync(new URL("../src-tauri/capabilities/default.json", import.meta.url), "utf8"));
const desktopCapability = JSON.parse(readFileSync(new URL("../src-tauri/capabilities/desktop.json", import.meta.url), "utf8"));
const overlayCapability = JSON.parse(readFileSync(new URL("../src-tauri/capabilities/voice-overlay.json", import.meta.url), "utf8"));
const selectionQuestionCapability = JSON.parse(readFileSync(new URL("../src-tauri/capabilities/selection-question-popup.json", import.meta.url), "utf8"));
const generatedCapabilities = JSON.parse(readFileSync(new URL("../src-tauri/gen/schemas/capabilities.json", import.meta.url), "utf8"));
const generatedAcl = JSON.parse(readFileSync(new URL("../src-tauri/gen/schemas/acl-manifests.json", import.meta.url), "utf8"));
const backgroundRecording = backend.slice(
  backend.indexOf("fn start_background_recording"),
  backend.indexOf("fn cancel_background_recording_start"),
);
const finishBackgroundProcessing = backend.slice(
  backend.indexOf("fn finish_background_processing"),
  backend.indexOf("fn validate_result_action"),
);
const guardedOverlayStart = backend.indexOf("fn set_voice_overlay_if_current(");
const guardedOverlay = backend.slice(
  guardedOverlayStart,
  backend.indexOf('\n#[cfg(target_os = "macos")]\n#[link(name = "ApplicationServices"', guardedOverlayStart),
);
const screenQuestion = app.slice(
  app.indexOf("async function openScreenQuestion()"),
  app.indexOf("function closeSelectionQuestion()"),
);

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
assert(/@media \(max-width: 900px\)[\s\S]*?\.voice-stage h1\s*\{[^}]*white-space:\s*nowrap;/s.test(styles), "狭い画面で見出しを折り返さない");
assert(app.includes("<em>AIで</em>言語化をイージーに"), "ホーム見出しを指定コピーにする");
assert(styles.includes('font-family: "RocknRoll One"'), "ホーム見出しにロゴ感のある日本語書体を使う");
assert(main.includes('@fontsource/rocknroll-one/400.css'), "RocknRoll Oneを配布物へ同梱する");
assert(ossNotices.includes("SIL OPEN FONT LICENSE Version 1.1"), "同梱フォントのOFL-1.1全文をOSS表示へ含める");
assert(
  tauriConfig.app.windows[0]?.backgroundThrottling === "disabled",
  "本体が背面・最小化中でもショートカット後の録音とAI処理を止めない",
);
assert(
  tauriConfig.app.windows[0]?.minWidth <= 320 && tauriConfig.app.windows[0]?.minHeight <= 240,
  "狭い画面でも本体ウィンドウを縮小できる",
);
assert(/@media \(max-width: 900px\)/.test(styles), "狭いデスクトップではサイドバーを折りたたむ");
assert(app.includes("fitMainWindowToWorkArea"), "起動時に本体ウィンドウを画面の作業領域へ合わせる");
assert(app.includes("outerPosition()") && app.includes("outerSize()"), "ウィンドウ枠を含めて画面内へ配置する");
assert(app.includes("snapshot.message"), "音声エラーの具体的な理由を表示する");
assert(JSON.stringify(overlayCapability.windows) === JSON.stringify(["voice-overlay"]), "音声オーバーレイの権限は専用ウィンドウだけに付与する");
assert(JSON.stringify(defaultCapability.windows) === JSON.stringify(["main"]), "標準Capabilityはメイン画面だけに付与する");
assert(JSON.stringify(defaultCapability.permissions) === JSON.stringify(["core:default"]), "標準Capabilityの既存コア権限を維持する");
assert(JSON.stringify(overlayCapability.permissions) === JSON.stringify(["allow-voice-overlay-status"]), "音声オーバーレイはエラー詳細コマンドだけを許可する");
assert(JSON.stringify(selectionQuestionCapability.windows) === JSON.stringify(["selection-question-popup"]), "質問ポップアップ権限を専用ウィンドウだけに付与する");
assert(
  JSON.stringify(selectionQuestionCapability.permissions) === JSON.stringify([
    "allow-selection-question-popup-payload",
    "allow-answer-open-question",
    "allow-close-selection-question-popup",
  ]),
  "質問ポップアップには必要な3コマンドだけを許可する",
);
const handlerCommands = backend
  .match(/\.invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\)/)?.[1]
  ?.split(",")
  .map((command) => command.trim())
  .filter(Boolean);
const manifestCommands = buildScript
  .match(/\.commands\(&\[([\s\S]*?)\]\)/)?.[1]
  ?.match(/"([a-z_]+)"/g)
  ?.map((command) => command.slice(1, -1));
assert(handlerCommands?.length, "登録済みTauriコマンド一覧を取得する");
assert(manifestCommands?.length, "AppManifestのTauriコマンド一覧を取得する");
assert(JSON.stringify(manifestCommands) === JSON.stringify(handlerCommands), "AppManifestとinvoke_handlerのコマンド一覧を一致させる");
assert(buildScript.includes("tauri_build::try_build") && buildScript.includes("tauri_build::AppManifest::new()"), "AppManifestでアプリコマンドのACLを生成する");
const appPermission = (command) => `allow-${command.replaceAll("_", "-")}`;
const mainCommandPermissions = desktopCapability.permissions.filter((permission) => permission.startsWith("allow-"));
assert(
  JSON.stringify(desktopCapability.windows) === JSON.stringify(["main"]),
  "メイン画面用のアプリコマンド権限はmainだけに付与する",
);
const popupCommands = ["selection_question_popup_payload", "answer_open_question", "close_selection_question_popup"];
const overlayCommands = ["voice_overlay_status"];
const literalFrontendCommands = [...app.matchAll(/appInvoke(?:<[^>]+>)?\(\s*"([a-z_]+)"/g)].map((match) => match[1]);
const dynamicFrontendCommands = ["retry_voice_processing", "clear_voice_result", "cancel_voice_processing"];
const frontendCommands = [...new Set([...literalFrontendCommands, ...dynamicFrontendCommands])];
assert(frontendCommands.every((command) => handlerCommands.includes(command)), "フロントエンドが使うコマンドは全てinvoke_handlerへ登録する");
const expectedMainPermissions = frontendCommands
  .filter((command) => !popupCommands.includes(command) && !overlayCommands.includes(command))
  .map(appPermission)
  .sort();
assert(JSON.stringify([...mainCommandPermissions].sort()) === JSON.stringify(expectedMainPermissions), "メイン画面には利用するアプリコマンドだけを許可する");
const generatedAppPermissions = generatedAcl["__app-acl__"]?.permissions;
assert(generatedAppPermissions, "AppManifestの権限を生成済みACLスキーマへ反映する");
for (const command of handlerCommands) {
  const permission = generatedAppPermissions[appPermission(command)];
  assert(JSON.stringify(permission?.commands?.allow) === JSON.stringify([command]), `${command}のallow権限を生成済みACLスキーマへ反映する`);
}
for (const [capability, source] of [
  [defaultCapability, "default"],
  [desktopCapability, "desktop-capability"],
  [overlayCapability, "voice-overlay-capability"],
  [selectionQuestionCapability, "selection-question-popup-capability"],
]) {
  const generated = generatedCapabilities[source];
  assert(generated, `${source}を生成済みCapabilityスキーマへ反映する`);
  assert(JSON.stringify(generated.windows) === JSON.stringify(capability.windows), `${source}の対象ウィンドウを生成済みスキーマと一致させる`);
  assert(JSON.stringify(generated.permissions) === JSON.stringify(capability.permissions), `${source}の権限を生成済みスキーマと一致させる`);
}
const overlayComponent = app.slice(app.indexOf("function VoiceOverlay()"), app.indexOf("function SelectionQuestionPopup()"));
assert(overlayComponent.includes('appInvoke<string>("voice_overlay_status")'), "音声オーバーレイは限定エラー詳細コマンドを読む");
for (const forbidden of ["background_voice_status", "background-voice-state", "voice-overlay-state", "listen<"]) {
  assert(!overlayComponent.includes(forbidden), `音声オーバーレイは広範な状態・イベント ${forbidden} を読まない`);
}
assert(!backend.includes('emit("voice-overlay-state"'), "音声状態はURL更新を使い、オーバーレイイベントを発行しない");
assert(/\.navigate\(next_url\)/.test(backend) && overlayComponent.includes('get("overlay")'), "音声状態はネイティブ遷移のURLクエリで伝える");
assert(
  desktopCapability.permissions.includes("process:allow-restart"),
  "更新を適用した後のアプリ再起動を許可する",
);
assert(
  backgroundRecording.indexOf('set_voice_overlay(app.clone(), "starting"') < backgroundRecording.indexOf("std::thread::spawn"),
  "マイクの準備中状態を表示してから録音スレッドを開始する",
);
assert(
  /set_voice_overlay_if_current\(\s*&recording_app,\s*generation,\s*BackgroundVoicePhase::Recording,\s*"listening"/s.test(backgroundRecording),
  "録音開始時は世代・録音状態が一致する場合だけ聞き取り中を表示する",
);
assert(
  !backgroundRecording.includes('set_voice_overlay(app.clone(), "listening"'),
  "録音スレッドの開始直後にエラー状態を聞き取り中で上書きしない",
);
assert(
  backend.includes("background_voice_question_context(selection_question, selection)"),
  "選択質問キーで選択がない場合は画面を読まず通常の音声入力へ戻す",
);
assert(
  finishBackgroundProcessing.includes('set_voice_overlay_if_current(app, generation, BackgroundVoicePhase::Idle, overlay)'),
  "処理完了後の古い表示が次の録音へ割り込まない",
);
assert(
  guardedOverlay.includes("run_on_main_thread")
    && guardedOverlay.indexOf("run_on_main_thread") < guardedOverlay.indexOf(".0.lock()"),
  "Tauriの画面更新をメインスレッドで実行し、その時点の状態を検査する",
);
assert(
  !/#\[tauri::command\]\s*fn set_voice_overlay/.test(backend)
    && !backend.slice(backend.indexOf(".invoke_handler(tauri::generate_handler!["), backend.indexOf(".build(tauri::generate_context!())")).includes("set_voice_overlay,"),
  "音声オーバーレイを状態ガードを迂回してWebViewから直接変更できない",
);
assert(
  screenQuestion.includes('appInvoke("open_frontmost_screen_question"') && !screenQuestion.includes('appInvoke("capture_selected_text"'),
  "選択が空でも前面画面の質問操作は選択文取得に依存しない",
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
assert(app.includes("現在の版:"), "更新欄に現在のアプリ版を表示する");
assert(app.includes("確認した最新版:"), "更新欄に確認した最新版を表示する");
assert(app.includes("showRefreshToast"), "右上の状態更新は完了通知を表示する");
assert(app.includes('appInvoke("check_microphone")'), "許可表示だけでなくネイティブ録音の接続確認を行う");
assert(app.includes("接続確認済み"), "実際に使えるマイクを許可済みと区別して表示する");
assert(app.includes("Ollamaアカウントは不要"), "Gemmaのローカル利用にアカウント登録が不要なことを明記する");
assert(app.includes("サインアップ不要でローカルAIを準備"), "Windowsで登録画面を開かないローカルAI準備導線を表示する");
assert(!app.includes("Ollamaを自動インストール"), "外部Ollamaアプリの登録導線を自動起動しない");
assert(app.includes("waitForLocalLlmStart"), "ローカルAIの起動確認後にGemma取得を案内する");
assert(app.includes("!local.running"), "未起動のローカルAIではGemma取得を開始しない");
assert(backend.includes("ollama-windows-amd64.zip"), "WindowsはOllama公式のスタンドアロンZIPを使う");
assert(!backend.includes("OllamaSetup.exe"), "WindowsでOllamaのGUIインストーラーを起動しない");
assert(backend.includes('Command::new("tar.exe")'), "WindowsのスタンドアロンZIPを展開する");
assert(backend.includes('serve.arg("serve")'), "展開したローカルAIをバックグラウンドで起動する");
assert(backend.includes("verify_sha256"), "取得したローカルAIを公式SHA-256と照合する");

console.info("PASS: UI制作規約v1.1の静的契約を検証しました");
