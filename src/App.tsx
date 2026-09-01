import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Check, CircleAlert, Download, ExternalLink, Mic, Plus, RefreshCw, WifiOff, X } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import { DEFAULT_OUTPUT_TARGET, isOutputTarget, OutputTarget, outputTargetLabel } from "./output-target";
import { DEFAULT_SHORTCUT, shortcutCaptureResult, shortcutLabel } from "./shortcut";
import { AudioRecorder, startAudioRecorder } from "./audio-recorder";

type ProviderId = "codex" | "claude";
type View = "home" | "dictionary" | "settings";
type ProviderStatus = { installed: boolean; authenticated: boolean; provider: ProviderId };
type LocalModel = { id: "gemma4_e2b"; name: string; size: string; installed: boolean };
type LocalLlmStatus = { installed: boolean; running: boolean; models: LocalModel[] };
type TranscriptionStatus = { downloaded: boolean; name: string; size: string };
type BrandGlyphName = "coach" | "dx" | "loop" | "move" | "spark" | "speed" | "system" | "work";

const providers: Array<{ id: ProviderId; label: string; detail: string; glyph: BrandGlyphName }> = [
  { id: "codex", label: "ChatGPT", detail: "Codexで接続", glyph: "spark" },
  { id: "claude", label: "Claude", detail: "Claude Codeで接続", glyph: "coach" },
];

function BrandGlyph({ name, className = "" }: { name: BrandGlyphName; className?: string }) {
  return <img className={`brand-glyph ${className}`.trim()} src={`/brand/icons/doon-glyph-${name}.png`} alt="" aria-hidden="true" />;
}

function appInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauriApp()) return invoke<T>(command, args);
  const preview: Record<string, unknown> = {
    provider_status: { installed: true, authenticated: false },
    local_llm_status: { installed: true, running: true, models: [{ id: "gemma4_e2b", name: "Gemma 4 E2B", size: "7.2 GB", installed: true }] },
    transcription_status: { downloaded: true, name: "DOON Voice 高精度音声認識", size: "約574 MB" },
    direct_input_status: true,
    request_direct_input_permission: true,
  };
  return Promise.resolve(preview[command] as T);
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

function isTauriApp() {
  return "__TAURI_INTERNALS__" in window;
}

function savedShortcut() {
  try { return window.localStorage.getItem("doon-voice-shortcut") || DEFAULT_SHORTCUT; }
  catch { return DEFAULT_SHORTCUT; }
}

function savedOutputTarget(): OutputTarget {
  try {
    const saved = window.localStorage.getItem("doon-voice-output-target");
    return isOutputTarget(saved) ? saved : DEFAULT_OUTPUT_TARGET;
  } catch { return DEFAULT_OUTPUT_TARGET; }
}

function savedList<T>(key: string): T[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value as T[] : [];
  } catch { return []; }
}

function duration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes ? `${minutes}分 ${rest}秒` : `${rest}秒`;
}

type OverlayState = "listening" | "thinking" | "done" | "error" | "hidden";
const MIN_THINKING_MS = 900;

function MainApp() {
  const [view, setView] = useState<View>("home");
  const [statuses, setStatuses] = useState<Record<ProviderId, ProviderStatus | null>>({ codex: null, claude: null });
  const [local, setLocal] = useState<LocalLlmStatus | null>(null);
  const [installingOllama, setInstallingOllama] = useState(false);
  const [pullingLocalModel, setPullingLocalModel] = useState(false);
  const [downloadingTranscription, setDownloadingTranscription] = useState(false);
  const [notice, setNotice] = useState("");
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [terms, setTerms] = useState<string[]>(() => savedList<string>("doon-voice-dictionary"));
  const [termDraft, setTermDraft] = useState("");
  const [shortcut, setShortcut] = useState(savedShortcut);
  const [capturingShortcut, setCapturingShortcut] = useState(false);
  const [outputTarget, setOutputTarget] = useState<OutputTarget>(savedOutputTarget);
  const [transcription, setTranscription] = useState<TranscriptionStatus | null>(null);
  const [transcript, setTranscript] = useState("");
  const [output, setOutput] = useState("");
  const [processing, setProcessing] = useState(false);
  const [directInputAllowed, setDirectInputAllowed] = useState<boolean | null>(null);
  const [connectingProviders, setConnectingProviders] = useState<Record<ProviderId, boolean>>({ codex: false, claude: false });
  const recorderRef = useRef<AudioRecorder | null>(null);
  const startRef = useRef<number | null>(null);
  const registeredShortcutRef = useRef<string | null>(null);
  const capturedFromShortcutRef = useRef<string | null>(null);
  const shortcutButtonRef = useRef<HTMLButtonElement | null>(null);
  const toggleRecordingRef = useRef<() => void>(() => {});
  const pullingLocalModelRef = useRef(false);
  const downloadingTranscriptionRef = useRef(false);

  useEffect(() => { void refreshAll(); }, []);
  useEffect(() => { window.localStorage.removeItem("doon-voice-history"); }, []);
  useEffect(() => { window.scrollTo(0, 0); }, [view]);
  useEffect(() => {
    const refreshPermission = () => {
      void appInvoke<boolean>("direct_input_status").then(setDirectInputAllowed).catch(() => undefined);
    };
    window.addEventListener("focus", refreshPermission);
    // macOSのシステム設定で許可を切り替えて戻ってきた場合、WebViewの
    // focusイベントだけでは通知されないことがあるため定期的に再確認する。
    const timer = window.setInterval(refreshPermission, 1000);
    return () => {
      window.removeEventListener("focus", refreshPermission);
      window.clearInterval(timer);
    };
  }, []);
  useEffect(() => () => { void recorderRef.current?.stop(); }, []);
  useEffect(() => () => { void setVoiceOverlay("hidden"); }, []);
  useEffect(() => () => {
    if (isTauriApp()) void appInvoke("clear_voice_shortcut").catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!isTauriApp()) return;
    let stopListening: (() => void) | undefined;
    void listen("doon-voice-shortcut", () => { toggleRecordingRef.current(); }).then((unlisten) => {
      stopListening = unlisten;
    });
    return () => stopListening?.();
  }, []);
  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => {
      if (startRef.current) setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 250);
    return () => window.clearInterval(timer);
  }, [recording]);
  useEffect(() => { if (capturingShortcut) shortcutButtonRef.current?.focus(); }, [capturingShortcut]);
  useEffect(() => { window.localStorage.setItem("doon-voice-dictionary", JSON.stringify(terms)); }, [terms]);

  async function refreshAll() {
    const [entries, localStatus, transcriptionStatus, directInputStatus] = await Promise.all([
      Promise.all(providers.map(async ({ id }) => [id, await appInvoke<ProviderStatus>("provider_status", { provider: id })] as const)),
      appInvoke<LocalLlmStatus>("local_llm_status").catch(() => null),
      appInvoke<TranscriptionStatus>("transcription_status").catch(() => null),
      appInvoke<boolean>("direct_input_status").catch(() => null),
    ]);
    const providerStatuses = Object.fromEntries(entries) as Record<ProviderId, ProviderStatus>;
    setStatuses(providerStatuses);
    setConnectingProviders((current) => ({
      codex: current.codex && !providerStatuses.codex.authenticated,
      claude: current.claude && !providerStatuses.claude.authenticated,
    }));
    setLocal(localStatus);
    setTranscription(transcriptionStatus);
    setDirectInputAllowed(directInputStatus);
  }

  async function stopMicrophone() {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    startRef.current = null;
    setRecording(false);
    setElapsed(0);
    setProcessing(true);
    setNotice("音声を文字にしています");
    const thinkingStartedAt = performance.now();
    await setVoiceOverlay("thinking");
    // Give the overlay webview one frame to paint before a fast local response
    // can move it to the completed state.
    await new Promise((resolve) => window.setTimeout(resolve, 80));
    try {
      const audio = await recorder?.stop();
      if (!audio) throw new Error("録音を受け取れませんでした。");
      const recognized = await appInvoke<string>("transcribe_voice", { audio: Array.from(audio), dictionary: terms });
      setTranscript(recognized);
      setNotice(`${outputTargetLabel(outputTarget)} で文章を整えています`);
      const result = await appInvoke<string>("process_voice_text", { target: outputTarget, text: recognized, dictionary: terms });
      setOutput(result);
      try {
        await appInvoke("paste_to_active_app", { text: result });
        const remainingThinkingMs = Math.max(0, MIN_THINKING_MS - (performance.now() - thinkingStartedAt));
        if (remainingThinkingMs > 0) await new Promise((resolve) => window.setTimeout(resolve, remainingThinkingMs));
        setNotice("カーソル位置へ文章を入力しました");
        void setVoiceOverlay("done");
        window.setTimeout(() => { void setVoiceOverlay("hidden"); }, 1200);
      }
      catch (error) {
        const message = errorMessage(error, "文章をクリップボードに保存しました");
        if (message.includes("アクセシビリティ")) {
          setDirectInputAllowed(false);
          setView("settings");
          void requestDirectInputPermission();
        }
        setNotice(message);
        void setVoiceOverlay("error");
        window.setTimeout(() => { void setVoiceOverlay("hidden"); }, 1800);
      }
    } catch (error) {
      const remainingThinkingMs = Math.max(0, MIN_THINKING_MS - (performance.now() - thinkingStartedAt));
      if (remainingThinkingMs > 0) await new Promise((resolve) => window.setTimeout(resolve, remainingThinkingMs));
      setNotice(errorMessage(error, "音声を処理できませんでした。もう一度試してください。"));
      void setVoiceOverlay("error");
      window.setTimeout(() => { void setVoiceOverlay("hidden"); }, 1800);
    } finally { setProcessing(false); }
  }

  async function toggleRecording() {
    if (processing) return;
    if (recording) { await stopMicrophone(); return; }
    if (!transcription?.downloaded) {
      setView("settings");
      setNotice("先に音声認識モデルを取得してください");
      return;
    }
    try {
      recorderRef.current = await startAudioRecorder();
      startRef.current = Date.now();
      setElapsed(0);
      setRecording(true);
      setTranscript("");
      setOutput("");
      setNotice("音声を受け取っています");
      void setVoiceOverlay("listening");
    } catch (error) {
      setNotice(errorMessage(error, "マイクを許可すると音声入力を始められます"));
    }
  }

  async function setVoiceOverlay(state: OverlayState) {
    if (!isTauriApp()) return;
    try { await appInvoke("set_voice_overlay", { state }); }
    catch { /* 状態表示だけの失敗で音声入力は止めない */ }
  }

  toggleRecordingRef.current = () => { void toggleRecording(); };

  async function applyShortcut(next: string, notify = true) {
    const previous = registeredShortcutRef.current;
    try {
      if (isTauriApp()) {
        await appInvoke("set_voice_shortcut", { shortcut: next });
        registeredShortcutRef.current = next;
      }
      window.localStorage.setItem("doon-voice-shortcut", next);
      setShortcut(next);
      setCapturingShortcut(false);
      capturedFromShortcutRef.current = null;
      if (notify) setNotice(`開始・停止キーを ${shortcutLabel(next, navigator.userAgent.includes("Mac"))} に変更しました`);
    } catch {
      const restore = previous ?? capturedFromShortcutRef.current;
      if (restore && isTauriApp()) {
        try {
          await appInvoke("set_voice_shortcut", { shortcut: restore });
          registeredShortcutRef.current = restore;
        } catch { /* 元のキーも使用中なら表示だけ残す */ }
      }
      setCapturingShortcut(false);
      capturedFromShortcutRef.current = null;
      setNotice("そのキーは他のアプリかOSが使っています。別の組み合わせを選んでください");
    }
  }

  useEffect(() => { void applyShortcut(shortcut, false); }, []);

  async function beginShortcutCapture() {
    const previous = registeredShortcutRef.current ?? shortcut;
    try {
      if (registeredShortcutRef.current && isTauriApp()) {
        await appInvoke("clear_voice_shortcut");
        registeredShortcutRef.current = null;
      }
      capturedFromShortcutRef.current = previous;
      setCapturingShortcut(true);
    } catch {
      setNotice("開始・停止キーの変更を始められませんでした。もう一度試してください");
    }
  }

  function cancelShortcutCapture() {
    const previous = capturedFromShortcutRef.current;
    setCapturingShortcut(false);
    if (previous) void applyShortcut(previous, false);
  }

  useEffect(() => {
    if (!capturingShortcut) return;
    const captureShortcut = (event: KeyboardEvent) => {
      if (event.repeat) return;
      event.preventDefault();
      event.stopPropagation();
      const result = shortcutCaptureResult(event);
      if (result.kind === "cancel") { cancelShortcutCapture(); return; }
      if (result.kind === "invalid") {
        setNotice("Control、Option/Alt、Shift、Commandのいずれかを一緒に押してください");
        return;
      }
      void applyShortcut(result.shortcut);
    };
    window.addEventListener("keydown", captureShortcut, true);
    return () => window.removeEventListener("keydown", captureShortcut, true);
  }, [capturingShortcut]);

  async function connect(provider: ProviderId) {
    if (!statuses[provider]?.installed) {
      setNotice(provider === "codex" ? "Codex CLIを入れてから接続してください" : "Claude Codeを入れてから接続してください");
      return;
    }
    try {
      setConnectingProviders((current) => ({ ...current, [provider]: true }));
      await appInvoke("start_official_login", { provider });
      setNotice(`${provider === "codex" ? "ChatGPT" : "Claude"} に接続しています`);
      void waitForProviderConnection(provider);
    } catch (error) {
      setConnectingProviders((current) => ({ ...current, [provider]: false }));
      setNotice(errorMessage(error, "接続を開始できませんでした"));
    }
  }

  async function waitForProviderConnection(provider: ProviderId) {
    const label = provider === "codex" ? "ChatGPT" : "Claude";
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
      try {
        const status = await appInvoke<ProviderStatus>("provider_status", { provider });
        setStatuses((current) => ({ ...current, [provider]: status }));
        if (status.authenticated) {
          setConnectingProviders((current) => ({ ...current, [provider]: false }));
          setNotice(`${label}に接続しました`);
          return;
        }
      } catch { /* 接続画面を開いたまま次の確認を続ける */ }
    }
    setConnectingProviders((current) => ({ ...current, [provider]: false }));
    setNotice(`${label}の接続を確認できませんでした。接続画面でログインしてから状態を更新してください`);
  }

  function chooseOutputTarget(target: OutputTarget) {
    window.localStorage.setItem("doon-voice-output-target", target);
    setOutputTarget(target);
    setNotice(`文章を整えるAIを ${outputTargetLabel(target)} に変更しました`);
  }

  async function installOllama() {
    if (installingOllama) return;
    setInstallingOllama(true);
    setNotice("Ollamaのインストーラーを取得しています。完了までこの画面を開いたままにしてください");
    try {
      await appInvoke("open_local_llm_install");
      setNotice("Ollamaのインストーラーを起動しました。完了後に更新するとGemmaを取得できます");
      window.setTimeout(() => { void refreshAll(); }, 3000);
    } catch (error) {
      setNotice(errorMessage(error, "Ollamaのインストーラーを取得できませんでした。公式サイトから手動で入れてください"));
    } finally {
      setInstallingOllama(false);
    }
  }

  async function openDirectInputSettings() {
    try { await appInvoke("open_direct_input_settings"); setNotice("アクセシビリティ設定を開きました。DOON Voiceが2つある場合は古い方を削除し、現在のアプリをオンにしてください"); }
    catch (error) { setNotice(errorMessage(error, "直接入力の設定を開けませんでした")); }
  }

  async function requestDirectInputPermission() {
    try {
      const allowed = await appInvoke<boolean>("request_direct_input_permission");
      setDirectInputAllowed(allowed);
      if (allowed) {
        setNotice("カーソル位置への入力を許可しました");
      } else {
        setNotice("アクセシビリティで現在のDOON Voiceをオンにしてください。2つある場合は古い方を削除すると反映されます");
      }
    } catch (error) {
      setNotice(errorMessage(error, "直接入力の許可を確認できませんでした"));
    }
  }

  async function pullModel() {
    if (pullingLocalModelRef.current) return;
    pullingLocalModelRef.current = true;
    setPullingLocalModel(true);
    setNotice("Gemma 4 E2Bを取得しています。完了までこの画面を開いたままにしてください");
    try {
      await appInvoke("pull_local_model");
      await refreshAll();
      setNotice("Gemma 4 E2Bを準備しました");
    } catch (error) {
      setNotice(errorMessage(error, "Gemma 4 E2Bを取得できませんでした"));
    } finally {
      pullingLocalModelRef.current = false;
      setPullingLocalModel(false);
    }
  }

  async function downloadTranscriptionModel() {
    if (downloadingTranscriptionRef.current) return;
    downloadingTranscriptionRef.current = true;
    setDownloadingTranscription(true);
    setNotice("日本語音声認識モデルを取得しています。完了までこの画面を開いたままにしてください");
    try {
      await appInvoke("download_transcription_model");
      await refreshAll();
      setNotice("日本語音声認識モデルを準備しました");
    } catch (error) {
      setNotice(errorMessage(error, "音声認識モデルを取得できませんでした"));
    } finally {
      downloadingTranscriptionRef.current = false;
      setDownloadingTranscription(false);
    }
  }

  async function copyOutput() {
    if (!output) return;
    try { await navigator.clipboard.writeText(output); setNotice("整えた文章をクリップボードにコピーしました"); }
    catch { setNotice("コピーできませんでした。文章を選択してコピーしてください"); }
  }

  function addTerm(event: FormEvent) {
    event.preventDefault();
    const term = termDraft.trim();
    if (!term || terms.includes(term)) return;
    setTerms((current) => [...current, term]);
    setTermDraft("");
  }

  const localModel = local?.models[0];
  const localReady = Boolean(local?.running && localModel?.installed);
  const isMac = navigator.userAgent.includes("Mac");
  useEffect(() => {
    if (!isMac || view !== "settings") return;
    const refreshPermission = () => {
      void appInvoke<boolean>("direct_input_status").then(setDirectInputAllowed).catch(() => undefined);
    };
    refreshPermission();
    const timer = window.setInterval(refreshPermission, 1200);
    return () => window.clearInterval(timer);
  }, [isMac, view]);
  function providerDisplayState(id: ProviderId, selected: boolean) {
    if (selected) return { label: "選択中", className: "state-selected" };
    if (connectingProviders[id]) return { label: "接続中", className: "state-connecting" };
    if (statuses[id]?.authenticated) return { label: "接続済み", className: "state-connected" };
    if (statuses[id]?.installed) return { label: "接続可能", className: "state-available" };
    return { label: "未導入", className: "state-unavailable" };
  }
  const codexDisplay = providerDisplayState("codex", outputTarget === "codex");
  const claudeDisplay = providerDisplayState("claude", outputTarget === "claude");
  const selectedOutput = outputTarget === "codex"
    ? { label: "ChatGPT", detail: "GPT-5.6 Luna", ready: Boolean(statuses.codex?.authenticated) }
    : outputTarget === "claude"
      ? { label: "Claude", detail: "Haiku", ready: Boolean(statuses.claude?.authenticated) }
      : { label: "このPCのAI", detail: localModel?.name || "未準備", ready: localReady };
  const nav = [
    { id: "home" as const, label: "ホーム", glyph: "work" as const },
    { id: "dictionary" as const, label: "辞書", glyph: "coach" as const },
  ];

  return <main className="app-shell">
    <aside className="sidebar" aria-label="DOON Voiceのメニュー">
      <button className="brand" type="button" onClick={() => setView("home")} aria-label="DOON Voice ホーム"><img src="/brand/doon-logo.png" alt="DOON" /><span>VOICE</span></button>
      <nav className="sidebar-nav">{nav.map(({ id, label, glyph }) => <button className={view === id ? "nav-item is-active" : "nav-item"} key={id} type="button" onClick={() => setView(id)}><BrandGlyph name={glyph} /> {label}</button>)}</nav>
      <div className="sidebar-bottom"><button className={view === "settings" ? "nav-item is-active" : "nav-item"} type="button" onClick={() => setView("settings")}><BrandGlyph name="system" /> 接続と設定</button><div className="local-state"><span className={selectedOutput.ready ? "status-dot is-ready" : "status-dot"} /> <span>文章整形</span><strong>{selectedOutput.label}</strong></div></div>
    </aside>

    <section className="main-canvas">
      <header className="main-bar"><span>{view === "home" ? "DOON VOICE" : view === "dictionary" ? "DICTIONARY" : "SETTINGS"}</span><div className="top-status"><span><i className={selectedOutput.ready ? "status-dot is-ready" : "status-dot"} />{selectedOutput.label}</span><span className="top-status-detail">{selectedOutput.detail}</span><button className="icon-button" type="button" onClick={() => void refreshAll()} aria-label="状態を更新"><RefreshCw size={16} strokeWidth={1.9} /></button></div></header>

      {view === "home" && <section className="home-view" aria-labelledby="home-title">
        <section className={recording ? "voice-stage is-recording" : "voice-stage"} aria-label="音声入力">
          <div className="hero-brand"><img src="/brand/doon-logo.png" alt="DOON" /><span>VOICE</span></div>
          <h1 id="home-title"><em>AIで</em>言語化を楽に</h1>
          <p>{recording ? `音声入力中 · ${duration(elapsed)}` : processing ? "文章を整えています" : "どのアプリにも、そのまま入力。"}</p>
          <button className="record-button" type="button" onClick={() => void toggleRecording()} disabled={processing} aria-label={recording ? "音声入力を停止" : "音声入力を開始"}><span className="record-button-icon"><Mic size={27} strokeWidth={1.8} /></span><strong>{recording ? "停止" : "話す"}</strong><small>{shortcutLabel(shortcut, isMac)}</small></button>
        </section>
        <section className="destination-section" aria-labelledby="destination-title">
          <div className="section-label"><span>FINISH WITH</span><h2 id="destination-title">文章の仕上げ</h2></div>
          <div className="destination-list">
            <button className={outputTarget === "codex" ? "is-selected" : ""} type="button" onClick={() => chooseOutputTarget("codex")} aria-pressed={outputTarget === "codex"}><BrandGlyph name="spark" /><span><strong>ChatGPT</strong><small className={codexDisplay.className}>{codexDisplay.label}</small></span>{outputTarget === "codex" && <Check size={16} strokeWidth={2.1} />}</button>
            <button className={outputTarget === "claude" ? "is-selected" : ""} type="button" onClick={() => chooseOutputTarget("claude")} aria-pressed={outputTarget === "claude"}><BrandGlyph name="coach" /><span><strong>Claude</strong><small className={claudeDisplay.className}>{claudeDisplay.label}</small></span>{outputTarget === "claude" && <Check size={16} strokeWidth={2.1} />}</button>
            <button className={outputTarget === "local" ? "is-selected" : ""} type="button" onClick={() => chooseOutputTarget("local")} aria-pressed={outputTarget === "local"}><BrandGlyph name="dx" /><span><strong>このPCのAI</strong><small className={outputTarget === "local" ? "state-selected" : localReady ? "state-running" : "state-unavailable"}>{outputTarget === "local" ? "選択中" : localReady ? "稼働中" : "未準備"}</small></span>{outputTarget === "local" && <Check size={16} strokeWidth={2.1} />}</button>
          </div>
        </section>
        {(transcript || output || processing) && <section className="result-section" aria-live="polite" aria-label="音声入力の結果">
          <div className="section-label"><span>RESULT</span><h2>整えた文章</h2></div>
          {processing && <p className="result-state">考えています</p>}
          {transcript && <p className="transcript">{transcript}</p>}
          {output && <><div className="result-output">{output}</div><div className="result-actions"><button className="outline-action" type="button" onClick={() => void copyOutput()}>文章をコピー</button><span>クリップボードに保存済み</span></div></>}
        </section>}
        {notice && <p className="notice" role="status">{notice}</p>}
      </section>}

      {view === "dictionary" && <section className="simple-view" aria-labelledby="dictionary-title"><div className="view-heading"><span>PERSONAL DICTIONARY</span><h1 id="dictionary-title">辞書</h1><p>固有名詞や大切な言葉を登録します。</p></div><form className="term-form" onSubmit={addTerm}><input value={termDraft} onChange={(event) => setTermDraft(event.target.value)} placeholder="言葉を追加" aria-label="辞書に追加する言葉" /><button type="submit"><Plus size={16} strokeWidth={2} /> 追加</button></form>{terms.length ? <ul className="term-list">{terms.map((term) => <li key={term}>{term}<button type="button" onClick={() => setTerms((current) => current.filter((item) => item !== term))} aria-label={`${term}を削除`}>×</button></li>)}</ul> : <div className="empty-state"><BrandGlyph name="coach" /><p>まだ登録した言葉はありません。</p></div>}</section>}

      {view === "settings" && <section className="simple-view settings-view" aria-labelledby="settings-title">
        <div className="view-heading"><span>SETTINGS</span><h1 id="settings-title">接続と設定</h1></div>
        <section className="output-settings" aria-labelledby="output-settings-title">
          <div className="output-settings-heading"><span>TEXT PROCESSOR</span><h2 id="output-settings-title">文章を整えるAI</h2></div>
          <div className="output-choice-list" role="radiogroup" aria-label="文章を整えるAI">
            <button className={outputTarget === "codex" ? "is-selected" : ""} type="button" role="radio" aria-checked={outputTarget === "codex"} onClick={() => chooseOutputTarget("codex")}><BrandGlyph name="spark" /><span><strong>ChatGPT</strong><small>Codexで整える</small></span>{outputTarget === "codex" ? <Check size={17} strokeWidth={2.2} /> : <span>選ぶ</span>}</button>
            <button className={outputTarget === "claude" ? "is-selected" : ""} type="button" role="radio" aria-checked={outputTarget === "claude"} onClick={() => chooseOutputTarget("claude")}><BrandGlyph name="coach" /><span><strong>Claude</strong><small>Claude Codeで整える</small></span>{outputTarget === "claude" ? <Check size={17} strokeWidth={2.2} /> : <span>選ぶ</span>}</button>
            <button className={outputTarget === "local" ? "is-selected" : ""} type="button" role="radio" aria-checked={outputTarget === "local"} onClick={() => chooseOutputTarget("local")}><BrandGlyph name="dx" /><span><strong>このPCのAI</strong><small>Gemma 4 E2Bで高速整形</small></span>{outputTarget === "local" ? <Check size={17} strokeWidth={2.2} /> : <span>選ぶ</span>}</button>
          </div>
        </section>
        <div className="settings-list direct-input-settings"><article><span className="setting-icon"><BrandGlyph name="move" /></span><div><h2>カーソル位置へ入力</h2><p>{directInputAllowed ? "ほかのアプリへ直接入力できます。" : "macOSのアクセシビリティ許可が必要です。"}</p></div><span className={directInputAllowed ? "setting-state state-permitted" : "setting-state state-unavailable"}>{directInputAllowed ? <Check size={15} strokeWidth={2.3} /> : <CircleAlert size={15} strokeWidth={2} />}{directInputAllowed ? "許可済み" : "未許可"}</span>{isMac ? <button className="outline-action" type="button" onClick={() => void (directInputAllowed ? openDirectInputSettings() : requestDirectInputPermission())}>{directInputAllowed ? "設定を開く" : "許可する"} <ExternalLink size={15} /></button> : <span />}</article></div>
        <div className="settings-list transcription-settings"><article><span className="setting-icon"><BrandGlyph name="work" /></span><div><h2>音声認識</h2><p>{transcription?.downloaded ? "日本語音声認識をこのPCで行います。" : "話した言葉を文字にする日本語モデルです。"}</p></div><span className={transcription?.downloaded ? "setting-state state-installed" : "setting-state state-unavailable"}>{transcription?.downloaded ? <Check size={15} strokeWidth={2.3} /> : <Download size={15} strokeWidth={2} />}{transcription?.downloaded ? "モデル取得済み" : downloadingTranscription ? "取得中" : transcription?.size || "未取得"}</span>{transcription?.downloaded ? <span /> : <button className="outline-action" type="button" onClick={() => void downloadTranscriptionModel()} disabled={downloadingTranscription}>{downloadingTranscription ? "取得中" : "モデルを取得"} <Download size={15} /></button>}</article></div>
        <div className="settings-list">{providers.map(({ id, label, glyph }) => { const status = providerDisplayState(id, false); const connecting = connectingProviders[id]; const connected = statuses[id]?.authenticated; return <article key={id}><span className="setting-icon"><BrandGlyph name={glyph} /></span><div><h2>{label}</h2><p>{id === "codex" ? "GPT-5.6 Lunaで高速整形" : "Claude Haikuで高速整形"}</p></div><span className={`setting-state ${status.className}`}>{connecting ? <span className="state-connecting-mark" aria-hidden="true" /> : connected ? <Check size={15} strokeWidth={2.3} /> : statuses[id]?.installed ? <span className="state-ring" aria-hidden="true" /> : <CircleAlert size={15} strokeWidth={2} />}{status.label}</span><button className="outline-action" type="button" onClick={() => void connect(id)} disabled={connecting}>{connecting ? "接続中" : connected ? "再接続" : "接続する"} {!connecting && <ExternalLink size={15} strokeWidth={1.9} />}</button></article>; })}<article><span className="setting-icon"><BrandGlyph name="dx" /></span><div><h2>ローカルAI</h2><p>{localReady ? "Gemma 4 E2BがこのPCで稼働中です。" : "Gemma 4 E2BをDOON Voice用に取得します。"}</p></div><span className={localReady ? "setting-state state-running" : "setting-state state-unavailable"}>{localReady ? <span className="state-live-dot" aria-hidden="true" /> : <WifiOff size={15} strokeWidth={2} />}{localReady ? "稼働中" : pullingLocalModel ? "取得中" : "未準備"}</span>{!local?.installed ? <button className="outline-action" type="button" onClick={() => void installOllama()} disabled={installingOllama}>{installingOllama ? "Ollamaを取得中" : "Ollamaを自動インストール"} <Download size={15} /></button> : !localModel?.installed ? <button className="outline-action" type="button" onClick={() => void pullModel()} disabled={pullingLocalModel}>{pullingLocalModel ? "取得中" : "Gemmaを取得"} <Download size={15} /></button> : <span />}</article><article className="shortcut-row"><span className="setting-icon"><BrandGlyph name="speed" /></span><div><h2>開始・停止キー</h2><p>{capturingShortcut ? "押した組み合わせを登録します。Escで取り消せます。" : "音声入力の開始と停止"}</p></div><button ref={shortcutButtonRef} className={capturingShortcut ? "shortcut-key is-capturing" : "shortcut-key"} type="button" onClick={() => void beginShortcutCapture()} aria-label="開始・停止キーを変更" aria-pressed={capturingShortcut}>{capturingShortcut ? "キーを押す" : shortcutLabel(shortcut, navigator.userAgent.includes("Mac"))}</button><button className="outline-action" type="button" onClick={() => void applyShortcut(DEFAULT_SHORTCUT)}>標準に戻す</button></article></div>{notice && <p className="notice" role="status">{notice}</p>}</section>}
    </section>

  </main>;
}

function VoiceOverlay() {
  const initial = new URLSearchParams(window.location.search).get("overlay");
  const [state, setState] = useState<OverlayState>(
    initial === "thinking" || initial === "done" || initial === "error" ? initial : "listening",
  );
  useEffect(() => {
    document.documentElement.classList.add("is-overlay");
    let stopListening: (() => void) | undefined;
    void listen<string>("voice-overlay-state", (event) => {
      if (event.payload === "listening" || event.payload === "thinking" || event.payload === "done" || event.payload === "error") {
        setState(event.payload);
      }
    }).then((unlisten) => { stopListening = unlisten; });
    return () => {
      stopListening?.();
      document.documentElement.classList.remove("is-overlay");
    };
  }, []);
  const label = state === "listening" ? "聞いています" : state === "thinking" ? "考えています" : state === "done" ? "入力しました" : "入力できませんでした";
  const detail = state === "listening" ? "音声を受け取っています" : state === "thinking" ? "選択したAIで文章を整えています" : state === "done" ? "カーソル位置へ入力しました" : "クリップボードに保存しました";
  return <main className={`voice-overlay is-${state}`} aria-live="assertive">
    <span className="voice-overlay-icon"><Mic size={25} strokeWidth={1.9} /></span>
    <span className="voice-overlay-copy"><small>DOON VOICE</small><strong>{label}</strong><em>{detail}</em></span>
    {state === "listening" ? <span className="voice-bars" aria-hidden="true"><i /><i /><i /><i /><i /></span> : state === "thinking" ? <span className="overlay-spinner" aria-hidden="true" /> : state === "error" ? <X size={21} strokeWidth={2.2} /> : <Check size={21} strokeWidth={2.2} />}
  </main>;
}

export default function App() {
  return new URLSearchParams(window.location.search).has("overlay") ? <VoiceOverlay /> : <MainApp />;
}
