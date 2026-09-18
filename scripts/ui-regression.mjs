import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// All OS commands and clipboard writes are replaced before the real App loads.
// PLAYWRIGHT_MODULE can point at an existing local Playwright installation.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = process.env.UI_ARTIFACTS || path.join(root, "output/playwright");
const server = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ headless: true });
let failures = 0;
const browserErrors = [];

function mockDesktop({ dictionary = [], dictionaryRaw, snapshot = {}, authenticated = {}, transcription = { downloaded: true, name: "音声認識", size: "574 MB" }, local = { installed: false, running: false, models: [] } } = {}) {
  localStorage.clear();
  localStorage.setItem("doon-voice-dictionary", dictionaryRaw ?? JSON.stringify(dictionary));
  localStorage.setItem("doon-voice-provider-connections", JSON.stringify({ codex: false, claude: false, gemini: false }));
  const callbacks = new Map();
  const listeners = new Map();
  let nextId = 1;
  const idle = { state: "idle", generation: 1, transcript: "", output: "", message: "", clipboard_saved: false, recovery_pending: false };
  window.fixture = {
    calls: [], errors: [], authenticated, clipboard: "", clipboardFails: false,
    selection: "この文章は選択された文脈です。", questionAnswer: "選択文を根拠にした回答です。", pastedAnswer: "",
    selectionQuestionPopup: { selection: "選択された説明文です。", question: "これは何ですか", answer: "選択文への自動回答です。", target: "codex" },
    registeredShortcut: null, registeredQuestionShortcut: null, snapshot: { ...idle, ...snapshot },
    deferClipboard: false, pendingClipboard: null, deferConfigs: false, rejectConfigs: false,
    pendingConfigs: [], activeTarget: "codex", activeSelectionQuestionTarget: "codex", activeDictionary: dictionary,
    deferConfigReplies: false, pendingConfigReplies: [], deferNextClear: false, pendingClear: null,
    transcription, local, pendingTranscriptionDownload: null, pendingLocalModelPull: null,
    commitConfig(args) {
      const dictionary = [...new Set(args.dictionary.map((term) => term.trim()))];
      if (this.snapshot.state !== "idle") {
        if (args.target === this.activeTarget && args.selectionQuestionTarget === this.activeSelectionQuestionTarget && JSON.stringify(dictionary) === JSON.stringify(this.activeDictionary)) return;
        throw new Error("音声入力中は設定を変更できません。処理が終わってから変更してください");
      }
      if (this.rejectConfigs) throw new Error("設定を保存できませんでした");
      this.activeTarget = args.target;
      this.activeSelectionQuestionTarget = args.selectionQuestionTarget;
      this.activeDictionary = dictionary;
    },
    resolveConfig(index = 0) {
      const job = this.pendingConfigs.splice(index, 1)[0];
      try { this.commitConfig(job.args); job.resolve(); }
      catch (error) { job.reject(error); }
    },
    publish(patch) {
      this.snapshot = { ...this.snapshot, ...patch };
      this.emit("background-voice-state", this.snapshot);
    },
    emit(event, payload) {
      for (const listener of listeners.values()) {
        if (listener.event === event) callbacks.get(listener.handler)?.({ payload });
      }
    },
  };
  window.addEventListener("unhandledrejection", (event) => window.fixture.errors.push(String(event.reason)));
  // Preserve the real 60-attempt login path while reducing only the sleep.
  const timeout = window.setTimeout.bind(window);
  window.setTimeout = (callback, ms, ...args) => timeout(callback, ms === 1500 ? 1 : ms, ...args);
  Object.defineProperty(navigator, "clipboard", { value: { async writeText(value) {
    if (window.fixture.clipboardFails) throw new Error("clipboard unavailable");
    if (window.fixture.deferClipboard) await new Promise((resolve) => { window.fixture.pendingClipboard = resolve; });
    window.fixture.clipboard = value;
  } } });
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    transformCallback(callback) { const id = nextId++; callbacks.set(id, callback); return id; },
    async invoke(command, args) {
      const f = window.fixture;
      f.calls.push({ command, args });
      if (["ack_voice_result", "clear_voice_result", "retry_voice_processing", "cancel_voice_processing"].includes(command) && args?.generation !== f.snapshot.generation) throw new Error("結果が更新されています");
      switch (command) {
        case "provider_status": return { provider: args.provider, installed: true, authenticated: Boolean(f.authenticated[args.provider]), usability: "unknown" };
        case "local_llm_status": return f.local;
        case "transcription_status": return f.transcription;
        case "download_transcription_model": return new Promise((resolve) => { f.pendingTranscriptionDownload = resolve; });
        case "pull_local_model": return new Promise((resolve) => { f.pendingLocalModelPull = resolve; });
        case "direct_input_status": return true;
        case "background_voice_status": return f.snapshot;
        case "capture_selected_text": return f.selection;
        case "transcribe_voice": return "これは何ですか";
        case "answer_selection_question": return f.questionAnswer;
        case "paste_question_answer": f.pastedAnswer = args.text; return;
        case "selection_question_popup_payload": return f.selectionQuestionPopup;
        case "close_selection_question_popup": return;
        case "configure_background_voice":
          if (f.deferConfigs) return new Promise((resolve, reject) => f.pendingConfigs.push({ args, resolve, reject }));
          f.commitConfig(args);
          if (f.deferConfigReplies) return new Promise((resolve) => f.pendingConfigReplies.push(resolve));
          return;
        case "set_voice_shortcut": f.registeredShortcut = args.shortcut; return;
        case "set_selection_question_shortcut": f.registeredQuestionShortcut = args.shortcut; return;
        case "clear_selection_question_shortcut": f.registeredQuestionShortcut = null; return;
        case "clear_voice_shortcut":
          f.registeredShortcut = null;
          if (f.deferNextClear) { f.deferNextClear = false; return new Promise((resolve) => { f.pendingClear = resolve; }); }
          return;
        case "start_official_login": return;
        case "toggle_background_voice": f.publish({ state: "starting" }); return;
        case "cancel_voice_processing": f.publish({ state: "idle", message: "処理を取り消しました" }); return;
        case "retry_voice_processing": f.publish({ state: "processing" }); return;
        case "ack_voice_result": f.publish({ clipboard_saved: true, recovery_pending: false }); return;
        case "clear_voice_result": f.publish(idle); return;
        case "plugin:event|listen": { const id = nextId++; listeners.set(id, args); return id; }
        case "plugin:event|unlisten": listeners.delete(args.eventId); return;
        default: throw new Error(`Unexpected desktop command: ${command}`);
      }
    },
  };
}

async function pageFor(options = {}, query = "") {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.setDefaultTimeout(2500);
  await page.addInitScript(mockDesktop, options);
  await page.goto(origin + "/" + query);
  await page.locator("main").waitFor();
  return page;
}

async function check(name, body) {
  const errorsBefore = browserErrors.length;
  try { await body(); assert.equal(browserErrors.length, errorsBefore, browserErrors.slice(errorsBefore).join("\n")); console.log(`PASS ${name}`); }
  catch (error) { failures += 1; console.error(`FAIL ${name}: ${error.stack || error.message}`); }
  finally { await Promise.all(browser.contexts().map((context) => context.close())); }
}

const recovery = { transcript: "明日は行きません。", output: "", recovery_pending: true, message: "文章整形に失敗しました" };
const formattedLongOutput = "明日の営業会議では、各担当が今週の進捗と次週までに決める事項を順番に共有します。\n\n資料の数字に変更があった担当は、会議前に最新版へ差し替えてください。\n\n終わりに、次回までの担当と期限を確認します。";

try {
  await check("RCS-006: error overlay never claims a successful clipboard write", async () => {
    const page = await pageFor({}, "?overlay=error");
    assert.doesNotMatch(await page.locator("main").innerText(), /クリップボードに保存しました/);
    await page.close();
  });

  await check("RCS-006: unsaved output has no saved claim", async () => {
    const page = await pageFor({ snapshot: { ...recovery, output: "確認用の結果", clipboard_saved: false } });
    await page.getByText("確認用の結果", { exact: true }).waitFor();
    assert.doesNotMatch(await page.locator("main").innerText(), /クリップボードに保存済み/);
    await page.close();
  });

  await check("DV-003: 長文の整形結果は段落改行を表示する", async () => {
    const page = await pageFor({ snapshot: { ...recovery, output: formattedLongOutput } });
    const output = page.locator(".result-output");
    await output.waitFor();
    assert.equal(await output.innerText(), formattedLongOutput);
    assert.equal(await output.evaluate((element) => getComputedStyle(element).whiteSpace), "pre-wrap");
    await page.close();
  });

  await check("初回モデル取得は容量・進捗・残り時間の目安を表示する", async () => {
    const page = await pageFor({ transcription: { downloaded: false, name: "音声認識", size: "約574 MB" } });
    await page.getByRole("button", { name: "接続と設定", exact: true }).click();
    await page.getByRole("button", { name: "モデルを取得", exact: true }).click();
    await page.evaluate(() => window.fixture.emit("installation-progress", {
      kind: "transcription", phase: "ダウンロード中", completed: 286 * 1024 * 1024, total: 574 * 1024 * 1024,
    }));
    await page.getByText(/約286 MB \/ 約574 MB · 49%/).waitFor();
    await page.getByText(/残り時間の目安/).waitFor();
    await mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: path.join(artifacts, "settings-install-progress-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(artifacts, "settings-install-progress-mobile.png"), fullPage: true });
    await page.close();
  });

  await check("初回設定でマイク許可の入口を常に表示する", async () => {
    const page = await pageFor();
    await page.getByRole("button", { name: "接続と設定", exact: true }).click();
    await page.getByRole("button", { name: "マイクを許可する", exact: true }).waitFor();
    await page.close();
  });

  await check("文章整形と選択文質問のAIを別々に保存して使う", async () => {
    const page = await pageFor({ local: { installed: true, running: true, models: [{ id: "gemma4_e2b", name: "Gemma 4 E2B", size: "7.2 GB", installed: true }] } });
    await page.getByRole("button", { name: "接続と設定", exact: true }).click();
    await page.getByRole("radiogroup", { name: "文章を整えるAI" }).getByRole("radio", { name: /このPCのAI/ }).click();
    await page.getByRole("radiogroup", { name: "選択文を質問するAI" }).getByRole("radio", { name: /Gemini/ }).click();
    await page.waitForFunction(() => window.fixture.activeTarget === "local" && window.fixture.activeSelectionQuestionTarget === "gemini");
    const settingsCall = await page.evaluate(() => window.fixture.calls.filter(({ command }) => command === "configure_background_voice").at(-1));
    assert.equal(settingsCall.args.target, "local");
    assert.equal(settingsCall.args.selectionQuestionTarget, "gemini");
    await page.getByRole("button", { name: "ホーム", exact: true }).click();
    await page.getByRole("button", { name: "選択した文章を質問", exact: true }).click();
    await page.getByRole("textbox", { name: "選択した文章への質問" }).fill("これは何ですか");
    await page.getByRole("button", { name: "質問する", exact: true }).click();
    await page.waitForFunction(() => window.fixture.calls.some(({ command, args }) => command === "answer_selection_question" && args.target === "gemini"));
    await page.close();
  });

  async function openSelectionQuestion(page) {
    await page.getByRole("button", { name: "選択した文章を質問", exact: true }).click();
    await page.getByRole("dialog", { name: "選択した文章を質問" }).waitFor();
    return page.getByRole("textbox", { name: "選択した文章への質問" });
  }

  await check("質問UI: 変換確定のEnterでは送信しない", async () => {
    const page = await pageFor();
    const input = await openSelectionQuestion(page);
    await input.fill("これは何ですか");
    await input.evaluate((element) => element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    await input.press("Enter");
    assert.equal(await page.evaluate(() => window.fixture.calls.some(({ command }) => command === "answer_selection_question")), false);
    await page.close();
  });

  await check("質問UI: 変換後のEnterで送信する", async () => {
    const page = await pageFor();
    const input = await openSelectionQuestion(page);
    await input.fill("これは何ですか");
    await input.evaluate((element) => element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
    await input.press("Enter");
    await page.getByText("選択文を根拠にした回答です。", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.fixture.calls.filter(({ command }) => command === "answer_selection_question").length), 1);
    await page.close();
  });

  await check("質問UI: Shift+Enterは改行して送信しない", async () => {
    const page = await pageFor();
    const input = await openSelectionQuestion(page);
    await input.fill("一行目");
    await input.press("Shift+Enter");
    await input.pressSequentially("二行目");
    assert.equal(await input.inputValue(), "一行目\n二行目");
    assert.equal(await page.evaluate(() => window.fixture.calls.some(({ command }) => command === "answer_selection_question")), false);
    await page.close();
  });

  await check("質問UI: 送信ボタンで質問し、回答をコピーと入力できる", async () => {
    const page = await pageFor();
    const input = await openSelectionQuestion(page);
    await input.fill("これは何ですか");
    await page.getByRole("button", { name: "質問する", exact: true }).click();
    await page.getByText("選択文を根拠にした回答です。", { exact: true }).waitFor();
    await page.getByRole("button", { name: "回答をコピー", exact: true }).click();
    assert.equal(await page.evaluate(() => window.fixture.clipboard), "選択文を根拠にした回答です。");
    await page.getByRole("button", { name: "カーソル位置へ入力", exact: true }).click();
    await page.waitForFunction(() => window.fixture.pastedAnswer === "選択文を根拠にした回答です。");
    await page.close();
  });

  await check("選択中に話した質問は回答ポップアップを自動で開く", async () => {
    const page = await pageFor();
    await page.evaluate(() => window.fixture.emit("selection-question-answer", {
      selection: "選択された説明文です。",
      question: "これは何ですか",
      answer: "選択文への自動回答です。",
    }));
    const dialog = page.getByRole("dialog", { name: "選択した文章を質問" });
    await dialog.waitFor();
    assert.equal(await page.getByRole("textbox", { name: "選択した文章への質問" }).inputValue(), "これは何ですか");
    await page.getByText("選択文への自動回答です。", { exact: true }).waitFor();
    await page.close();
  });

  await check("選択文の回答はDOON Voice本体を開かない専用ウィンドウで操作できる", async () => {
    const page = await pageFor({}, "?selection-question-popup");
    const dialog = page.getByRole("dialog", { name: "選択した文章を質問" });
    await dialog.waitFor();
    await page.getByText("選択された説明文です。", { exact: true }).waitFor();
    await page.getByText("選択文への自動回答です。", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "音声入力を開始" }).count(), 0);
    await page.getByRole("button", { name: "回答をコピー", exact: true }).click();
    assert.equal(await page.evaluate(() => window.fixture.clipboard), "選択文への自動回答です。");
    assert.equal(await page.getByRole("button", { name: "カーソル位置へ入力", exact: true }).count(), 0);
    await mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: path.join(artifacts, "selection-question-popup-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(artifacts, "selection-question-popup-mobile.png"), fullPage: true });
    await page.close();
  });

  await check("選択中の音声質問が失敗しても質問ポップアップに理由を表示する", async () => {
    const page = await pageFor();
    await page.evaluate(() => window.fixture.emit("selection-question-error", {
      selection: "選択された説明文です。",
      question: "これは何ですか",
      error: "ChatGPTの応答が時間切れになりました。",
    }));
    const dialog = page.getByRole("dialog", { name: "選択した文章を質問" });
    await dialog.waitFor();
    assert.equal(await page.getByRole("textbox", { name: "選択した文章への質問" }).inputValue(), "これは何ですか");
    await page.getByText("ChatGPTの応答が時間切れになりました。", { exact: true }).waitFor();
    await page.close();
  });

  await check("RCS-006: failed copy preserves original; successful copy acknowledges recovery", async () => {
    const page = await pageFor({ snapshot: recovery });
    await page.evaluate(() => { window.fixture.clipboardFails = true; });
    await page.getByRole("button", { name: "原文をコピー", exact: true }).click();
    assert.equal(await page.evaluate(() => window.fixture.snapshot.recovery_pending), true);
    assert.equal(await page.evaluate(() => window.fixture.calls.some(({ command }) => command === "ack_voice_result" || command === "clear_voice_result")), false);
    await page.evaluate(() => { window.fixture.clipboardFails = false; });
    await page.getByRole("button", { name: "原文をコピー", exact: true }).click();
    await page.waitForFunction(() => !window.fixture.snapshot.recovery_pending);
    assert.equal(await page.evaluate(() => window.fixture.clipboard), recovery.transcript);
    assert.equal(await page.getByText(recovery.transcript, { exact: true }).count(), 1);
    await page.close();
  });

  await check("recovery keeps voice input usable without discarding", async () => {
    const page = await pageFor({ snapshot: recovery });
    assert.equal(await page.getByRole("button", { name: "音声入力を開始" }).isEnabled(), true);
    assert.equal(await page.getByRole("button", { name: "選択した文章を質問" }).isEnabled(), true);
    await page.getByRole("button", { name: "音声入力を開始" }).click();
    await page.waitForFunction(() => window.fixture.calls.some(({ command }) => command === "toggle_background_voice"));
    assert.equal(await page.evaluate(() => window.fixture.snapshot.recovery_pending), true);
    await page.evaluate(() => window.fixture.publish({ state: "idle" }));
    await page.waitForFunction(() => document.querySelector('[aria-label="音声入力を開始"]')?.disabled === false);
    assert.equal(await page.getByRole("button", { name: "音声入力を開始" }).isEnabled(), true);
    await page.close();
  });

  await check("late clipboard completion never acknowledges the next result generation", async () => {
    const page = await pageFor({ snapshot: recovery });
    await page.evaluate(() => { window.fixture.deferClipboard = true; });
    await page.getByRole("button", { name: "原文をコピー", exact: true }).click();
    await page.waitForFunction(() => window.fixture.pendingClipboard !== null);
    await page.evaluate(() => {
      window.fixture.publish({ generation: 2, transcript: "次の原文", clipboard_saved: false, recovery_pending: true });
      window.fixture.pendingClipboard();
    });
    await page.getByRole("button", { name: "原文をコピー", exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector(".result-actions button")?.disabled);
    assert.equal(await page.getByRole("button", { name: "音声入力を開始" }).isEnabled(), true);
    assert.doesNotMatch(await page.locator(".result-actions").innerText(), /コピー済み/);
    assert.equal(await page.evaluate(() => window.fixture.calls.some(({ command, args }) => command === "ack_voice_result" && args?.generation !== 1)), false);
    await page.close();
  });

  await check("recording disables result operations while keeping stop available", async () => {
    const page = await pageFor({ snapshot: { ...recovery, state: "recording", output: "前回の結果" } });
    for (const name of ["原文をコピー", "文章をコピー", "再試行", "破棄"]) assert.equal(await page.getByRole("button", { name, exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "音声入力を停止" }).isEnabled(), true);
    await page.close();
  });

  for (const state of ["starting", "recording", "processing"]) {
    for (const view of ["ホーム", "接続と設定"]) {
      await check(`DV-002: ${state} locks all AI choices in ${view} and idle restores them`, async () => {
        const page = await pageFor({ snapshot: { state } });
        await page.getByRole("button", { name: view, exact: true }).click();
        const choices = page.locator(view === "ホーム" ? ".destination-list > button" : ".output-choice-list > button");
        assert.equal(await choices.count(), view === "ホーム" ? 5 : 9);
        for (const choice of await choices.all()) assert.equal(await choice.isDisabled(), true);
        const callsBefore = await page.evaluate(() => window.fixture.calls.length);
        await choices.evaluateAll((buttons) => buttons.forEach((button) => button.click()));
        assert.equal(await page.evaluate((start) => window.fixture.calls.slice(start).some(({ command }) => command === "configure_background_voice"), callsBefore), false);
        assert.equal(await page.evaluate(() => window.fixture.activeTarget), "codex");

        await page.evaluate(() => window.fixture.publish({ state: "idle" }));
        const formattingChoices = view === "ホーム" ? choices : page.getByRole("radiogroup", { name: "文章を整えるAI" }).getByRole("radio");
        for (const [index, target] of ["raw", "codex", "claude", "gemini", "local"].entries()) {
          await formattingChoices.nth(index).click();
          await page.waitForFunction((expected) => localStorage.getItem("doon-voice-output-target") === expected, target);
          assert.equal(await page.evaluate(() => window.fixture.activeTarget), target);
        }
        await page.close();
      });
    }
  }

  for (const view of ["ホーム", "接続と設定"]) {
    await check(`DV-002: ${view} rejects a click when a shortcut starts before React rerenders`, async () => {
      const page = await pageFor();
      await page.getByRole("button", { name: view, exact: true }).click();
      await page.waitForFunction(() => localStorage.getItem("doon-voice-output-target") === "codex");
      const callsBefore = await page.evaluate(() => window.fixture.calls.length);
      await page.evaluate((selector) => {
        const button = document.querySelector(selector);
        window.fixture.publish({ state: "starting", generation: 2 });
        button.click();
      }, view === "ホーム" ? ".destination-list > button" : ".output-choice-list > button");
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.evaluate((start) => window.fixture.calls.slice(start).some(({ command }) => command === "configure_background_voice"), callsBefore), false);
      assert.equal(await page.evaluate(() => window.fixture.activeTarget), "codex");
      assert.equal(await page.evaluate(() => localStorage.getItem("doon-voice-output-target")), "codex");
      await page.close();
    });
  }

  for (const state of ["starting", "processing"]) {
    await check(`DV-002: mobile ${state} controls fit within the viewport`, async () => {
      const page = await pageFor({ snapshot: { state } });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: "処理を取り消す" }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.close();
    });
  }

  await check("DV-002: a saved configuration ACK survives shortcut start, but the next queued change is cancelled", async () => {
    const page = await pageFor();
    await page.waitForFunction(() => localStorage.getItem("doon-voice-output-target") === "codex");
    await page.evaluate(() => { window.fixture.deferConfigReplies = true; });
    await page.getByRole("button", { name: /^Claude/ }).click();
    await page.waitForFunction(() => window.fixture.pendingConfigReplies.length === 1);
    await page.getByRole("button", { name: /^Gemini/ }).click();
    await page.evaluate(() => {
      window.fixture.publish({ state: "starting", generation: 2 });
      window.fixture.deferConfigReplies = false;
      window.fixture.pendingConfigReplies.shift()();
    });
    await page.getByText("設定を保存しています", { exact: true }).waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => window.fixture.activeTarget), "claude");
    assert.equal(await page.evaluate(() => localStorage.getItem("doon-voice-output-target")), "claude");
    assert.equal(await page.getByRole("button", { name: /^Claude/ }).getAttribute("aria-pressed"), "true");
    assert.equal(await page.evaluate(() => window.fixture.calls.some(({ command, args }) => command === "configure_background_voice" && args.target === "gemini")), false);
    assert.equal(await page.getByRole("button", { name: "設定を再保存", exact: true }).count(), 0);
    await page.evaluate(() => window.fixture.publish({ state: "idle" }));
    await page.getByRole("button", { name: /^Gemini/ }).click();
    await page.waitForFunction(() => localStorage.getItem("doon-voice-output-target") === "gemini");
    await page.close();
  });

  await check("DV-002: a shortcut racing an in-flight configuration keeps the previous acknowledged selection", async () => {
    const page = await pageFor();
    await page.waitForFunction(() => localStorage.getItem("doon-voice-output-target") === "codex");
    await page.evaluate(() => { window.fixture.deferConfigs = true; });
    await page.getByRole("button", { name: /AIなし/ }).click();
    await page.waitForFunction(() => window.fixture.pendingConfigs.length === 1);
    await page.evaluate(() => { window.fixture.publish({ state: "processing", generation: 2 }); window.fixture.resolveConfig(); });
    await page.getByText("設定を保存しています", { exact: true }).waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => window.fixture.activeTarget), "codex");
    assert.equal(await page.evaluate(() => localStorage.getItem("doon-voice-output-target")), "codex");
    assert.equal(await page.getByRole("button", { name: /^ChatGPT/ }).getAttribute("aria-pressed"), "true");
    await page.close();
  });

  await check("rejected configuration preserves the last acknowledged AI selection", async () => {
    const page = await pageFor();
    await page.evaluate(() => { window.fixture.rejectConfigs = true; });
    await page.getByRole("button", { name: /^Claude/ }).click();
    await page.getByText("設定を保存できませんでした", { exact: true }).first().waitFor();
    assert.equal(await page.getByRole("button", { name: /^ChatGPT/ }).getAttribute("aria-pressed"), "true");
    assert.notEqual(await page.evaluate(() => localStorage.getItem("doon-voice-output-target")), "claude");
    assert.equal(await page.evaluate(() => window.fixture.activeTarget), "codex");
    await page.close();
  });

  await check("rapid AI selections cannot commit an older configuration last", async () => {
    const page = await pageFor();
    await page.evaluate(() => { window.fixture.deferConfigs = true; });
    await page.getByRole("button", { name: /^Claude/ }).click();
    await page.getByRole("button", { name: /^Gemini/ }).click();
    await page.waitForFunction(() => window.fixture.pendingConfigs.length > 0);
    assert.equal(await page.getByRole("button", { name: /^ChatGPT/ }).getAttribute("aria-pressed"), "true");
    const count = await page.evaluate(() => window.fixture.pendingConfigs.length);
    if (count > 1) {
      await page.evaluate(() => { window.fixture.resolveConfig(1); window.fixture.resolveConfig(0); });
    } else {
      await page.evaluate(() => window.fixture.resolveConfig());
      await page.waitForFunction(() => window.fixture.pendingConfigs.length === 1);
      await page.evaluate(() => window.fixture.resolveConfig());
    }
    await page.waitForFunction(() => localStorage.getItem("doon-voice-output-target") === "gemini");
    await page.getByRole("button", { name: /^Gemini/, pressed: true }).waitFor();
    assert.equal(await page.evaluate(() => window.fixture.activeTarget), "gemini");
    assert.equal(await page.getByRole("button", { name: /^Gemini/ }).getAttribute("aria-pressed"), "true");
    await page.close();
  });

  await check("retry rechecks result generation after a delayed configuration save", async () => {
    const page = await pageFor({ snapshot: recovery });
    await page.evaluate(() => { window.fixture.deferConfigs = true; });
    await page.getByRole("button", { name: "再試行", exact: true }).click();
    await page.waitForFunction(() => window.fixture.pendingConfigs.length === 1);
    await page.evaluate(() => { window.fixture.publish({ generation: 2, transcript: "次の原文" }); window.fixture.resolveConfig(); });
    await page.waitForFunction(() => !document.querySelector(".result-actions button")?.disabled);
    assert.equal(await page.evaluate(() => window.fixture.calls.some(({ command }) => command === "retry_voice_processing")), false);
    assert.equal(await page.evaluate(() => window.fixture.snapshot.recovery_pending), true);
    await page.close();
  });

  await check("選択文を質問するキーは音声入力キーと別に登録できる", async () => {
    const page = await pageFor();
    await page.getByRole("button", { name: "接続と設定", exact: true }).click();
    await page.getByRole("button", { name: "選択文を質問するキーを変更" }).click();
    await page.waitForFunction(() => window.fixture.calls.some(({ command }) => command === "clear_selection_question_shortcut"));
    await page.keyboard.press("Control+Shift+Q");
    await page.waitForFunction(() => window.fixture.calls.some(({ command, args }) => command === "set_selection_question_shortcut" && args.shortcut === "Ctrl+Shift+Q"));
    assert.equal(await page.evaluate(() => window.fixture.registeredShortcut), "Ctrl+Alt+Space");
    assert.equal(await page.evaluate(() => window.fixture.registeredQuestionShortcut), "Ctrl+Shift+Q");
    await page.close();
  });

  await check("an old shortcut-clear response cannot restore over a newer shortcut", async () => {
    const page = await pageFor();
    await page.getByRole("button", { name: "接続と設定", exact: true }).click();
    await page.evaluate(() => { window.fixture.deferNextClear = true; });
    await page.getByRole("button", { name: "開始・停止キーを変更" }).click();
    await page.waitForFunction(() => window.fixture.pendingClear !== null);
    await page.getByRole("button", { name: "ホーム", exact: true }).click();
    await page.getByRole("button", { name: "接続と設定", exact: true }).click();
    await page.getByRole("button", { name: "開始・停止キーを変更" }).click();
    await page.keyboard.press("Control+Shift+K");
    await page.waitForFunction(() => window.fixture.registeredShortcut === "Ctrl+Shift+K");
    await page.evaluate(() => window.fixture.pendingClear());
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => window.fixture.registeredShortcut), "Ctrl+Shift+K");
    await page.close();
  });

  for (const destination of ["辞書", "ホーム", "blur", "Escape"]) {
    await check(`RCS-009: shortcut capture cancels on ${destination}`, async () => {
      const page = await pageFor();
      await page.getByRole("button", { name: "接続と設定", exact: true }).click();
      await page.getByRole("button", { name: "開始・停止キーを変更" }).click();
      await page.waitForFunction(() => window.fixture.registeredShortcut === null);
      if (destination === "blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      else if (destination === "Escape") await page.keyboard.press("Escape");
      else await page.getByRole("button", { name: destination, exact: true }).click();
      await page.waitForFunction(() => window.fixture.registeredShortcut !== null);
      if (destination === "辞書") {
        await page.getByRole("textbox", { name: "辞書に追加する言葉" }).pressSequentially("abc");
        assert.equal(await page.getByRole("textbox", { name: "辞書に追加する言葉" }).inputValue(), "abc");
      }
      assert.equal(await page.evaluate(() => window.fixture.registeredShortcut), "Ctrl+Alt+Space");
      await page.close();
    });
  }

  for (const resume of ["refresh", "focus"]) {
    await check(`RCS-010: late login completes on ${resume}, only for the requested provider`, async () => {
      const page = await pageFor();
      await page.getByRole("button", { name: "接続と設定", exact: true }).click();
      const claude = page.locator("article").filter({ has: page.getByRole("heading", { name: "Claude", exact: true }) });
      await claude.getByRole("button", { name: "ログインする" }).click();
      await page.getByRole("status").filter({ hasText: "ログインを確認できませんでした" }).waitFor();
      await page.evaluate(() => { window.fixture.authenticated = { codex: true, claude: true, gemini: true }; });
      if (resume === "focus") await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      else await page.getByRole("button", { name: "状態を更新" }).click();
      await claude.getByRole("button", { name: "再ログイン" }).waitFor();
      assert.doesNotMatch(await page.locator("main").innerText(), /ログインを確認できませんでした/);
      assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("doon-voice-provider-connections"))), { codex: false, claude: true, gemini: false });
      await page.close();
    });
  }

  await check("RCS-013: dictionary accepts 100 and rejects 101 with visible reason", async () => {
    const page = await pageFor({ dictionary: Array.from({ length: 99 }, (_, i) => `語${i}`) });
    await page.getByRole("button", { name: "辞書", exact: true }).click();
    const input = page.getByRole("textbox", { name: "辞書に追加する言葉" });
    await input.fill("100件目"); await input.press("Enter");
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("doon-voice-dictionary")).length === 100);
    await input.fill("101件目"); await input.press("Enter");
    await page.getByRole("alert").filter({ hasText: "100" }).waitFor();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("doon-voice-dictionary")).length), 100);
    await page.close();
  });

  await check("RCS-013: 80 Unicode codepoints accepted, 81 rejected", async () => {
    const page = await pageFor();
    await page.getByRole("button", { name: "辞書", exact: true }).click();
    const input = page.getByRole("textbox", { name: "辞書に追加する言葉" });
    await input.fill("😀".repeat(80)); await input.press("Enter");
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("doon-voice-dictionary")).length === 1);
    await input.fill("言".repeat(81)); await input.press("Enter");
    await page.getByRole("alert").filter({ hasText: "80" }).waitFor();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("doon-voice-dictionary")).length), 1);
    await page.close();
  });

  await check("RCS-013: existing oversized entries remain visible and explicitly invalid", async () => {
    const page = await pageFor({ dictionary: ["長".repeat(81)] });
    await page.getByRole("button", { name: "辞書", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "80" }).waitFor();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("doon-voice-dictionary"))[0].length), 81);
    await page.close();
  });

  await check("RCS-013: existing 101 entries are preserved until explicit removal", async () => {
    const page = await pageFor({ dictionary: Array.from({ length: 101 }, (_, i) => `保存語${i}`) });
    await page.getByRole("button", { name: "辞書", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "100" }).waitFor();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("doon-voice-dictionary")).length), 101);
    assert.equal(await page.evaluate(() => window.fixture.calls.some(({ command }) => command === "configure_background_voice")), false);
    await page.getByRole("button", { name: "保存語100を削除", exact: true }).click();
    await page.waitForFunction(() => window.fixture.calls.some(({ command, args }) => command === "configure_background_voice" && args.dictionary.length === 100));
    assert.equal(await page.getByRole("alert").count(), 0);
    await page.close();
  });

  await check("RCS-013: malformed legacy item can be removed without crashing", async () => {
    const page = await pageFor({ dictionary: [null, { broken: "data" }] });
    await page.getByRole("button", { name: "辞書", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "無効" }).waitFor();
    await page.getByRole("button", { name: "nullを削除", exact: true }).click();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("doon-voice-dictionary")).length), 1);
    await page.close();
  });

  for (const dictionaryRaw of ['["保存途中の辞書"', '{"unexpected":"dictionary"}']) {
    await check("RCS-013: unreadable saved dictionary is preserved until explicit reset", async () => {
      const page = await pageFor({ dictionaryRaw });
      await page.getByRole("button", { name: "辞書", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "読み取れません" }).waitFor();
      assert.equal(await page.evaluate(() => localStorage.getItem("doon-voice-dictionary")), dictionaryRaw);
      assert.equal(await page.evaluate(() => window.fixture.calls.some(({ command }) => command === "configure_background_voice")), false);
      await page.getByRole("button", { name: "読めない辞書を削除", exact: true }).click();
      await page.waitForFunction(() => localStorage.getItem("doon-voice-dictionary") === "[]");
      assert.equal(await page.getByRole("alert").count(), 0);
      await page.close();
    });
  }

  await check("AI-free raw mode is selectable and persisted", async () => {
    const page = await pageFor();
    await page.getByRole("button", { name: /AIなし/ }).click();
    await page.waitForFunction(() => localStorage.getItem("doon-voice-output-target") === "raw");
    await page.waitForFunction(() => window.fixture.calls.some(({ command, args }) => command === "configure_background_voice" && args.target === "raw"));
    await page.close();
  });

  for (const state of ["starting", "processing"]) {
    await check(`${state}: accurate state and cancellation`, async () => {
      const page = await pageFor({ snapshot: { state } });
      if (state === "starting") await page.getByText("マイクを準備しています", { exact: true }).first().waitFor();
      await page.getByRole("button", { name: "処理を取り消す" }).click();
      await page.waitForFunction(() => window.fixture.snapshot.state === "idle");
      await page.close();
    });
  }

  if (process.env.UI_SCREENSHOTS) {
    await mkdir(artifacts, { recursive: true });
    const page = await pageFor({ snapshot: { ...recovery, output: formattedLongOutput } });
    for (const [label, width, height] of [["pc", 1440, 900], ["mobile", 390, 844]]) {
      await page.setViewportSize({ width, height });
      for (const [view, name] of [["home", "ホーム"], ["settings", "接続と設定"], ["dictionary", "辞書"]]) {
        await page.getByRole("button", { name, exact: true }).click();
        await page.screenshot({ path: path.join(artifacts, `${label}-${view}.png`), fullPage: true });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${label}-${view}: horizontal overflow`);
      }
      await page.getByRole("button", { name: "ホーム", exact: true }).click();
      await page.getByRole("button", { name: "選択した文章を質問", exact: true }).click();
      await page.screenshot({ path: path.join(artifacts, `${label}-selection-question.png`), fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${label}-selection-question: horizontal overflow`);
      await page.getByRole("button", { name: "質問を閉じる", exact: true }).click();
      await page.evaluate(() => { window.fixture.rejectConfigs = true; });
      await page.getByRole("button", { name: /AIなし/ }).click();
      await page.getByText("設定を保存できませんでした", { exact: true }).waitFor();
      await page.screenshot({ path: path.join(artifacts, `${label}-config-error.png`), fullPage: true });
      await page.evaluate(() => { window.fixture.rejectConfigs = false; window.fixture.deferConfigs = true; });
      await page.getByRole("button", { name: /AIなし/ }).click();
      await page.getByText("設定を保存しています", { exact: true }).waitFor();
      await page.screenshot({ path: path.join(artifacts, `${label}-config-saving.png`), fullPage: true });
      await page.evaluate(() => { window.fixture.resolveConfig(); window.fixture.deferConfigs = false; });
      await page.getByText("設定を保存しています", { exact: true }).waitFor({ state: "detached" });
    }
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
if (failures) process.exitCode = 1;
console.log(`UI regression failures: ${failures}`);
