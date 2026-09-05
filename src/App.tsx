import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Check, CircleAlert, Download, ExternalLink, Mic, Plus, RefreshCw, WifiOff, X } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import { DEFAULT_OUTPUT_TARGET, isOutputTarget, OutputTarget, outputTargetLabel } from "./output-target";
import { DEFAULT_SHORTCUT, shortcutCaptureResult, shortcutLabel } from "./shortcut";

type ProviderId = "codex" | "claude" | "gemini";
type ProviderConnections = Record<ProviderId, boolean>;
type View = "home" | "dictionary" | "settings";
type ProviderStatus = {
  installed: boolean;
  authenticated: boolean;
  provider: ProviderId;
  usability: "unknown" | "available" | "unavailable";
};
type LocalModel = { id: "gemma4_e2b"; name: string; size: string; installed: boolean };
type LocalLlmStatus = { installed: boolean; running: boolean; models: LocalModel[] };
type TranscriptionStatus = { downloaded: boolean; name: string; size: string };
type BrandGlyphName = "coach" | "dx" | "loop" | "move" | "spark" | "speed" | "system" | "work";
type BackgroundVoiceSnapshot = {
  state: "idle" | "starting" | "recording" | "processing";
  transcript: string;
  output: string;
  message: string;
  clipboard_saved: boolean;
  recovery_pending: boolean;
};

const MAX_DICTIONARY_TERMS = 100;
const MAX_TERM_CODEPOINTS = 80;

function dictionaryError(terms: readonly unknown[]): string {
  if (terms.length > MAX_DICTIONARY_TERMS) return `辞書は${MAX_DICTIONARY_TERMS}件までです。不要な言葉を削除してください`;
  if (terms.some((term) => typeof term !== "string" || !term.trim())) return "辞書に無効なデータがあります。該当する項目を削除してください";
  if (terms.some((term) => Array.from((term as string).trim()).length > MAX_TERM_CODEPOINTS)) return `辞書の言葉は${MAX_TERM_CODEPOINTS}文字までです。長すぎる言葉を削除してください`;
  return "";
}

const providers: Array<{ id: ProviderId; label: string; detail: string; glyph: BrandGlyphName }> = [
  { id: "codex", label: "ChatGPT", detail: "Codexで接続", glyph: "spark" },
  { id: "claude", label: "Claude", detail: "Claude Codeで接続", glyph: "coach" },
  { id: "gemini", label: "Gemini", detail: "Antigravityで接続", glyph: "loop" },
];

function BrandGlyph({ name, className = "" }: { name: BrandGlyphName; className?: string }) {
  // DOON独自絵柄は、ユーザー指定により操作記号ではなくブランド表現として維持する。
  return <img className={`brand-glyph ${className}`.trim()} src={`/brand/icons/doon-glyph-${name}.png`} alt="" aria-hidden="true" />;
}

function appInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauriApp()) return invoke<T>(command, args);
  const preview: Record<string, unknown> = {
    provider_status: { installed: true, authenticated: false, usability: "unknown" },
    local_llm_status: { installed: true, running: true, models: [{ id: "gemma4_e2b", name: "Gemma 4 E2B", size: "7.2 GB", installed: true }] },
    transcription_status: { downloaded: true, name: "DOON Voice 高精度音声認識", size: "約574 MB" },
    direct_input_status: true,
    request_direct_input_permission: true,
    background_voice_status: { state: "idle", transcript: "", output: "", message: "", clipboard_saved: false, recovery_pending: false },
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

function savedProviderConnections(key = "doon-voice-provider-connections"): ProviderConnections {
  try {
    const saved = JSON.parse(window.localStorage.getItem(key) || "null");
    if (saved && typeof saved === "object") {
      return { codex: saved.codex === true, claude: saved.claude === true, gemini: saved.gemini === true };
    }
  } catch { /* 明示的な接続の記録がない場合は接続済みと推測しない */ }
  return { codex: false, claude: false, gemini: false };
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

type OverlayState = "starting" | "listening" | "thinking" | "done" | "error" | "hidden";

function MainApp() {
  const initialOutputTarget = useRef(savedOutputTarget()).current;
  const [view, setView] = useState<View>("home");
  const [statuses, setStatuses] = useState<Record<ProviderId, ProviderStatus | null>>({ codex: null, claude: null, gemini: null });
  const [connectedProviders, setConnectedProviders] = useState<ProviderConnections>(() => savedProviderConnections());
  const pendingConnectionsRef = useRef(savedProviderConnections("doon-voice-pending-connections"));
  const [local, setLocal] = useState<LocalLlmStatus | null>(null);
  const [installingOllama, setInstallingOllama] = useState(false);
  const [pullingLocalModel, setPullingLocalModel] = useState(false);
  const [downloadingTranscription, setDownloadingTranscription] = useState(false);
  const [notice, setNotice] = useState("");
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [terms, setTerms] = useState<unknown[]>(() => savedList<unknown>("doon-voice-dictionary"));
  const [termDraft, setTermDraft] = useState("");
  const [termError, setTermError] = useState("");
  const [shortcut, setShortcut] = useState(savedShortcut);
  const [capturingShortcut, setCapturingShortcut] = useState(false);
  const [outputTarget, setOutputTarget] = useState<OutputTarget>(initialOutputTarget);
  const [transcription, setTranscription] = useState<TranscriptionStatus | null>(null);
  const [transcript, setTranscript] = useState("");
  const [output, setOutput] = useState("");
  const [processing, setProcessing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [clipboardSaved, setClipboardSaved] = useState(false);
  const [recoveryPending, setRecoveryPending] = useState(false);
  const [resultActionPending, setResultActionPending] = useState(false);
  const [directInputAllowed, setDirectInputAllowed] = useState<boolean | null>(null);
  const [connectingProviders, setConnectingProviders] = useState<Record<ProviderId, boolean>>({ codex: false, claude: false, gemini: false });
  const startRef = useRef<number | null>(null);
  const registeredShortcutRef = useRef<string | null>(null);
  const capturedFromShortcutRef = useRef<string | null>(null);
  const shortcutCaptureActiveRef = useRef(false);
  const shortcutButtonRef = useRef<HTMLButtonElement | null>(null);
  const pullingLocalModelRef = useRef(false);
  const downloadingTranscriptionRef = useRef(false);

  useEffect(() => { void refreshAll(); }, []);
  useEffect(() => { window.localStorage.removeItem("doon-voice-history"); }, []);
  useEffect(() => { window.scrollTo(0, 0); }, [view]);
  useEffect(() => {
    const refreshPermission = () => {
      void appInvoke<boolean>("direct_input_status").then(setDirectInputAllowed).catch(() => undefined);
    };
    const refreshOnFocus = () => { void refreshAll(); };
    window.addEventListener("focus", refreshOnFocus);
    // macOSのシステム設定で許可を切り替えて戻ってきた場合、WebViewの
    // focusイベントだけでは通知されないことがあるため定期的に再確認する。
    const timer = window.setInterval(refreshPermission, 1000);
    return () => {
      window.removeEventListener("focus", refreshOnFocus);
      window.clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!isTauriApp()) return;
    let stopListening: (() => void) | undefined;
    let disposed = false;
    void appInvoke<BackgroundVoiceSnapshot>("background_voice_status")
      .then(applyBackgroundVoiceSnapshot)
      .catch(() => undefined);
    void listen<BackgroundVoiceSnapshot>("background-voice-state", (event) => {
      applyBackgroundVoiceSnapshot(event.payload);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stopListening = unlisten;
    }).catch(() => setNotice("音声入力の状態を受け取れませんでした"));
    return () => { disposed = true; stopListening?.(); };
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
  useEffect(() => {
    if (!isTauriApp() || dictionaryError(terms)) return;
    void appInvoke("configure_background_voice", { target: outputTarget, dictionary: terms })
      .catch((error) => setNotice(errorMessage(error, "音声入力の設定を保存できませんでした")));
  }, [outputTarget, terms]);

  function applyBackgroundVoiceSnapshot(snapshot: BackgroundVoiceSnapshot) {
    const isRecording = snapshot.state === "recording";
    setRecording(isRecording);
    setProcessing(snapshot.state === "processing");
    setStarting(snapshot.state === "starting");
    setClipboardSaved(snapshot.clipboard_saved);
    setRecoveryPending(snapshot.recovery_pending);
    if (isRecording && startRef.current === null) {
      startRef.current = Date.now();
      setElapsed(0);
    } else if (!isRecording) {
      startRef.current = null;
      setElapsed(0);
    }
    setTranscript(snapshot.transcript);
    setOutput(snapshot.output);
    if (snapshot.message) {
      setNotice(snapshot.message);
      if (snapshot.message.includes("アクセシビリティ")) setDirectInputAllowed(false);
    }
    if (snapshot.state === "idle" && (snapshot.output || snapshot.message.includes("利用が無効"))) {
      void refreshAll();
    }
  }

  async function refreshAll() {
    await Promise.all([
      ...providers.map(async ({ id }) => {
        try {
          const status = await appInvoke<ProviderStatus>("provider_status", { provider: id });
          setStatuses((current) => ({ ...current, [id]: status }));
          completePendingConnection(id, status);
        } catch {
          setStatuses((current) => ({ ...current, [id]: null }));
        }
      }),
      appInvoke<LocalLlmStatus>("local_llm_status").then(setLocal).catch(() => setLocal(null)),
      appInvoke<TranscriptionStatus>("transcription_status").then(setTranscription).catch(() => setTranscription(null)),
      appInvoke<boolean>("direct_input_status").then(setDirectInputAllowed).catch(() => setDirectInputAllowed(null)),
    ]);
  }

  function setPendingConnection(provider: ProviderId, pending: boolean) {
    pendingConnectionsRef.current = { ...pendingConnectionsRef.current, [provider]: pending };
    window.localStorage.setItem("doon-voice-pending-connections", JSON.stringify(pendingConnectionsRef.current));
  }

  function completePendingConnection(provider: ProviderId, status: ProviderStatus) {
    if (!status.authenticated || !pendingConnectionsRef.current[provider]) return false;
    setPendingConnection(provider, false);
    setConnectedProviders((current) => {
      const next = ({ ...current, [provider]: true });
      window.localStorage.setItem("doon-voice-provider-connections", JSON.stringify(next));
      return next;
    });
    setConnectingProviders((current) => ({ ...current, [provider]: false }));
    const label = outputTargetLabel(provider);
    setNotice((current) => current.includes(`${label}のログイン`) || current.includes(`${label} のログイン`)
      ? `${label}へログインしました。利用可否は文章整形時に確認します`
      : current);
    return true;
  }

  async function toggleRecording() {
    try {
      await appInvoke("toggle_background_voice");
    } catch (error) {
      setNotice(errorMessage(error, "音声入力を切り替えられませんでした"));
    }
  }

  async function applyShortcut(next: string, notify = true) {
    shortcutCaptureActiveRef.current = false;
    setCapturingShortcut(false);
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
        } catch {
          registeredShortcutRef.current = null;
          setNotice("元の開始・停止キーを復元できませんでした。設定からキーを登録し直してください");
          capturedFromShortcutRef.current = null;
          return;
        }
      }
      setCapturingShortcut(false);
      capturedFromShortcutRef.current = null;
      setNotice("そのキーは他のアプリかOSが使っています。別の組み合わせを選んでください");
    }
  }

  useEffect(() => { void applyShortcut(shortcut, false); }, []);

  async function beginShortcutCapture() {
    if (shortcutCaptureActiveRef.current) return;
    const previous = registeredShortcutRef.current ?? shortcut;
    capturedFromShortcutRef.current = previous;
    shortcutCaptureActiveRef.current = true;
    try {
      if (registeredShortcutRef.current && isTauriApp()) {
        await appInvoke("clear_voice_shortcut");
        registeredShortcutRef.current = null;
      }
      if (shortcutCaptureActiveRef.current) setCapturingShortcut(true);
      else await applyShortcut(previous, false);
    } catch {
      shortcutCaptureActiveRef.current = false;
      capturedFromShortcutRef.current = null;
      setNotice("開始・停止キーの変更を始められませんでした。もう一度試してください");
    }
  }

  function cancelShortcutCapture() {
    if (!shortcutCaptureActiveRef.current) return;
    shortcutCaptureActiveRef.current = false;
    const previous = capturedFromShortcutRef.current;
    setCapturingShortcut(false);
    if (previous) void applyShortcut(previous, false);
  }

  function navigate(next: View) {
    cancelShortcutCapture();
    setView(next);
  }

  useEffect(() => {
    window.addEventListener("blur", cancelShortcutCapture);
    return () => {
      window.removeEventListener("blur", cancelShortcutCapture);
      if (shortcutCaptureActiveRef.current && capturedFromShortcutRef.current) {
        void appInvoke("set_voice_shortcut", { shortcut: capturedFromShortcutRef.current });
      }
    };
  }, []);

  useEffect(() => {
    if (!capturingShortcut) return;
    const captureShortcut = (event: KeyboardEvent) => {
      if (!shortcutCaptureActiveRef.current) return;
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
      setNotice(provider === "codex" ? "Codex CLIを入れてから接続してください" : provider === "claude" ? "Claude Codeを入れてから接続してください" : "Antigravity CLIを入れてから接続してください");
      return;
    }
    try {
      setConnectingProviders((current) => ({ ...current, [provider]: true }));
      await appInvoke("start_official_login", { provider });
      setPendingConnection(provider, true);
      setNotice(`${provider === "codex" ? "ChatGPT" : provider === "claude" ? "Claude" : "Gemini"} のログインを確認しています`);
      void waitForProviderConnection(provider);
    } catch (error) {
      setConnectingProviders((current) => ({ ...current, [provider]: false }));
      setNotice(errorMessage(error, "接続を開始できませんでした"));
    }
  }

  async function waitForProviderConnection(provider: ProviderId) {
    const label = provider === "codex" ? "ChatGPT" : provider === "claude" ? "Claude" : "Gemini";
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
      if (!pendingConnectionsRef.current[provider]) return;
      try {
        const status = await appInvoke<ProviderStatus>("provider_status", { provider });
        setStatuses((current) => ({ ...current, [provider]: status }));
        if (completePendingConnection(provider, status)) return;
      } catch { /* 接続画面を開いたまま次の確認を続ける */ }
    }
    if (!pendingConnectionsRef.current[provider]) return;
    setConnectingProviders((current) => ({ ...current, [provider]: false }));
    setNotice(`${label}のログインを確認できませんでした。ログイン画面を確認してから状態を更新してください`);
  }

  function chooseOutputTarget(target: OutputTarget) {
    window.localStorage.setItem("doon-voice-output-target", target);
    setOutputTarget(target);
    setNotice(target === "raw" ? "AIなしの音声入力に変更しました" : `文章を整えるAIを ${outputTargetLabel(target)} に変更しました`);
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

  async function copyResult(text: string) {
    if (!text || resultActionPending) return;
    setResultActionPending(true);
    try {
      await navigator.clipboard.writeText(text);
      setClipboardSaved(true);
      try {
        await appInvoke("ack_voice_result");
        setRecoveryPending(false);
        setNotice("クリップボードにコピーしました");
      } catch {
        setNotice("コピーしましたが、回収状態を更新できませんでした。もう一度コピーしてください");
      }
    } catch {
      setNotice("コピーできませんでした。文章を選択してコピーしてください");
    } finally { setResultActionPending(false); }
  }

  async function resultAction(command: "retry_voice_processing" | "clear_voice_result" | "cancel_voice_processing") {
    if (resultActionPending) return;
    setResultActionPending(true);
    try {
      if (command === "retry_voice_processing") {
        await appInvoke("configure_background_voice", { target: outputTarget, dictionary: terms });
      }
      await appInvoke(command);
      applyBackgroundVoiceSnapshot(await appInvoke<BackgroundVoiceSnapshot>("background_voice_status"));
      if (command === "clear_voice_result") setNotice("文章を破棄しました");
    } catch (error) {
      setNotice(errorMessage(error, "操作を完了できませんでした。内容はこの画面で確認できます"));
    } finally { setResultActionPending(false); }
  }

  function addTerm(event: FormEvent) {
    event.preventDefault();
    const term = termDraft.trim();
    if (!term) { setTermError("言葉を入力してください"); return; }
    if (terms.includes(term)) { setTermError("この言葉は登録済みです"); return; }
    const error = dictionaryError([...terms, term]);
    if (error) { setTermError(error); return; }
    setTerms((current) => [...current, term]);
    setTermDraft("");
    setTermError("");
  }

  const localModel = local?.models[0];
  const existingDictionaryError = dictionaryError(terms);
  const busy = starting || processing;
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
    if (statuses[id]?.usability === "unavailable") return { label: "利用不可", className: "state-unavailable" };
    if (selected) return { label: "選択中", className: "state-selected" };
    if (connectingProviders[id]) return { label: "ログイン中", className: "state-connecting" };
    if (connectedProviders[id] && statuses[id]?.usability === "available") return { label: "利用可能", className: "state-connected" };
    if (connectedProviders[id] && statuses[id]?.authenticated) return { label: "ログイン済み", className: "state-available" };
    if (statuses[id]?.installed) return { label: "ログイン可能", className: "state-available" };
    return { label: "未導入", className: "state-unavailable" };
  }
  const codexDisplay = providerDisplayState("codex", outputTarget === "codex");
  const claudeDisplay = providerDisplayState("claude", outputTarget === "claude");
  const geminiDisplay = providerDisplayState("gemini", outputTarget === "gemini");
  const selectedOutput = outputTarget === "codex"
    ? { label: "ChatGPT", detail: "GPT-5.6 Luna", ready: statuses.codex?.usability === "available" }
    : outputTarget === "claude"
      ? { label: "Claude", detail: "Haiku", ready: statuses.claude?.usability === "available" }
      : outputTarget === "gemini"
        ? { label: "Gemini", detail: "Flash Low", ready: statuses.gemini?.usability === "available" }
        : outputTarget === "raw"
          ? { label: "AIなし", detail: "音声認識のみ", ready: Boolean(transcription?.downloaded) }
          : { label: "このPCのAI", detail: localModel?.name || "未準備", ready: localReady };
  const nav = [
    { id: "home" as const, label: "ホーム", glyph: "work" as const },
    { id: "dictionary" as const, label: "辞書", glyph: "coach" as const },
  ];

  return <main className="app-shell">
    <aside className="sidebar" aria-label="DOON Voiceのメニュー">
      <button className="brand" type="button" onClick={() => navigate("home")} aria-label="DOON Voice ホーム"><img src="/brand/doon-logo.png" alt="DOON" /><span>VOICE</span></button>
      <nav className="sidebar-nav">{nav.map(({ id, label, glyph }) => <button className={view === id ? "nav-item is-active" : "nav-item"} key={id} type="button" onClick={() => navigate(id)}><BrandGlyph name={glyph} /> {label}</button>)}</nav>
      <div className="sidebar-bottom"><button className={view === "settings" ? "nav-item is-active" : "nav-item"} type="button" onClick={() => navigate("settings")}><BrandGlyph name="system" /> 接続と設定</button><div className="local-state"><span className={selectedOutput.ready ? "status-dot is-ready" : "status-dot"} /> <span>文章の仕上げ</span><strong>{selectedOutput.label}</strong></div></div>
    </aside>

    <section className="main-canvas">
      <header className="main-bar"><span>{view === "home" ? "DOON VOICE" : view === "dictionary" ? "DICTIONARY" : "SETTINGS"}</span><div className="top-status"><span><i className={selectedOutput.ready ? "status-dot is-ready" : "status-dot"} />{selectedOutput.label}</span><span className="top-status-detail">{selectedOutput.detail}</span><button className="icon-button" type="button" onClick={() => void refreshAll()} aria-label="状態を更新"><RefreshCw size={16} strokeWidth={1.9} /></button></div></header>

      {view === "home" && <section className="home-view" aria-labelledby="home-title">
        <section className={recording ? "voice-stage is-recording" : "voice-stage"} aria-label="音声入力">
          <div className="hero-brand"><img src="/brand/doon-logo.png" alt="DOON" /><span>VOICE</span></div>
          <h1 id="home-title"><em>AIで</em>言語化をイージーに</h1>
          <p>{recording ? `音声入力中 · ${duration(elapsed)}` : starting ? "マイクを準備しています" : processing ? "音声を処理しています" : "どのアプリにも、そのまま入力。"}</p>
          <button className="record-button" type="button" onClick={() => void toggleRecording()} disabled={busy || (!recording && (recoveryPending || Boolean(existingDictionaryError)))} aria-label={recording ? "音声入力を停止" : "音声入力を開始"}><span className="record-button-icon"><Mic size={27} strokeWidth={1.8} /></span><strong>{recording ? "停止" : "話す"}</strong><small>{shortcutLabel(shortcut, isMac)}</small></button>
          {busy && <button className="outline-action cancel-processing" type="button" onClick={() => void resultAction("cancel_voice_processing")} disabled={resultActionPending} aria-label="処理を取り消す">取り消す</button>}
          {recoveryPending && !busy && <p className="recovery-state">前回の内容を確認してください</p>}
          {existingDictionaryError && <p className="recovery-state" role="alert">辞書に修正が必要です <button className="outline-action" type="button" onClick={() => navigate("dictionary")}>辞書を確認</button></p>}
        </section>
        <section className="destination-section" aria-labelledby="destination-title">
          <div className="section-label"><span>FINISH WITH</span><h2 id="destination-title">文章の仕上げ</h2></div>
          <div className="destination-list">
            <button className={outputTarget === "raw" ? "is-selected" : ""} type="button" onClick={() => chooseOutputTarget("raw")} aria-pressed={outputTarget === "raw"}><Mic size={27} strokeWidth={1.8} /><span><strong>AIなし</strong><small>{outputTarget === "raw" ? "選択中" : "音声認識のみ"}</small></span>{outputTarget === "raw" && <Check size={16} strokeWidth={2.1} />}</button>
            <button className={outputTarget === "codex" ? "is-selected" : ""} type="button" onClick={() => chooseOutputTarget("codex")} aria-pressed={outputTarget === "codex"}><BrandGlyph name="spark" /><span><strong>ChatGPT</strong><small className={codexDisplay.className}>{codexDisplay.label}</small></span>{outputTarget === "codex" && <Check size={16} strokeWidth={2.1} />}</button>
            <button className={outputTarget === "claude" ? "is-selected" : ""} type="button" onClick={() => chooseOutputTarget("claude")} aria-pressed={outputTarget === "claude"}><BrandGlyph name="coach" /><span><strong>Claude</strong><small className={claudeDisplay.className}>{claudeDisplay.label}</small></span>{outputTarget === "claude" && <Check size={16} strokeWidth={2.1} />}</button>
            <button className={outputTarget === "gemini" ? "is-selected" : ""} type="button" onClick={() => chooseOutputTarget("gemini")} aria-pressed={outputTarget === "gemini"}><BrandGlyph name="loop" /><span><strong>Gemini</strong><small className={geminiDisplay.className}>{geminiDisplay.label}</small></span>{outputTarget === "gemini" && <Check size={16} strokeWidth={2.1} />}</button>
            <button className={outputTarget === "local" ? "is-selected" : ""} type="button" onClick={() => chooseOutputTarget("local")} aria-pressed={outputTarget === "local"}><BrandGlyph name="dx" /><span><strong>このPCのAI</strong><small className={outputTarget === "local" ? "state-selected" : localReady ? "state-running" : "state-unavailable"}>{outputTarget === "local" ? "選択中" : localReady ? "稼働中" : "未準備"}</small></span>{outputTarget === "local" && <Check size={16} strokeWidth={2.1} />}</button>
          </div>
        </section>
        {(transcript || output || processing) && <section className="result-section" aria-live="polite" aria-label="音声入力の結果">
          <div className="section-label"><span>RESULT</span><h2>音声入力の結果</h2></div>
          {processing && <p className="result-state">音声を処理しています</p>}
          {transcript && <><h3 className="result-label">原文</h3><p className="transcript">{transcript}</p></>}
          {output && <><h3 className="result-label">{outputTarget === "raw" ? "入力する文章" : "整形結果"}</h3><div className="result-output">{output}</div></>}
          {(transcript || output) && <div className="result-actions">
            {transcript && <button className="outline-action" type="button" disabled={busy || resultActionPending} onClick={() => void copyResult(transcript)}>原文をコピー</button>}
            {output && <button className="outline-action" type="button" disabled={busy || resultActionPending} onClick={() => void copyResult(output)}>文章をコピー</button>}
            {transcript && outputTarget !== "raw" && <button className="outline-action" type="button" disabled={busy || resultActionPending || Boolean(existingDictionaryError)} onClick={() => void resultAction("retry_voice_processing")}>再試行</button>}
            <button className="outline-action" type="button" disabled={busy || resultActionPending} onClick={() => void resultAction("clear_voice_result")}>破棄</button>
            <span>{clipboardSaved ? "クリップボードにコピー済み" : "クリップボードに未保存"}</span>
          </div>}
        </section>}
        {notice && <p className="notice" role="status">{notice}</p>}
      </section>}

      {view === "dictionary" && <section className="simple-view" aria-labelledby="dictionary-title">
        <div className="view-heading"><span>PERSONAL DICTIONARY</span><h1 id="dictionary-title">辞書</h1></div>
        <form className="term-form" onSubmit={addTerm}><input value={termDraft} onChange={(event) => { setTermDraft(event.target.value); setTermError(""); }} placeholder="言葉を追加" aria-label="辞書に追加する言葉" aria-describedby="dictionary-limits" aria-invalid={Boolean(termError)} /><button type="submit"><Plus size={16} strokeWidth={2} /> 追加</button></form>
        <p className="dictionary-limits" id="dictionary-limits">{terms.length} / {MAX_DICTIONARY_TERMS}件 · 1件{MAX_TERM_CODEPOINTS}文字まで</p>
        {(termError || existingDictionaryError) && <p className="dictionary-error" role="alert">{termError || existingDictionaryError}</p>}
        {terms.length ? <ul className="term-list">{terms.map((term, index) => {
          const label = typeof term === "string" ? term : JSON.stringify(term);
          return <li key={index}><span>{label || "空の言葉"}</span><button type="button" onClick={() => { setTerms((current) => current.filter((_, itemIndex) => itemIndex !== index)); setTermError(""); }} aria-label={`${label || "無効な項目"}を削除`}><X size={14} strokeWidth={2} /></button></li>;
        })}</ul> : <div className="empty-state"><BrandGlyph name="coach" /><p>登録した言葉はありません</p></div>}
      </section>}

      {view === "settings" && <section className="simple-view settings-view" aria-labelledby="settings-title">
        <div className="view-heading"><span>SETTINGS</span><h1 id="settings-title">接続と設定</h1></div>
        <section className="output-settings" aria-labelledby="output-settings-title">
          <div className="output-settings-heading"><span>TEXT PROCESSOR</span><h2 id="output-settings-title">文章を整えるAI</h2></div>
          <div className="output-choice-list" role="radiogroup" aria-label="文章を整えるAI">
            <button className={outputTarget === "raw" ? "is-selected" : ""} type="button" role="radio" aria-checked={outputTarget === "raw"} onClick={() => chooseOutputTarget("raw")}><Mic size={27} strokeWidth={1.8} /><span><strong>AIなし</strong><small>音声認識のみ</small></span>{outputTarget === "raw" ? <Check size={17} strokeWidth={2.2} /> : <span>選ぶ</span>}</button>
            <button className={outputTarget === "codex" ? "is-selected" : ""} type="button" role="radio" aria-checked={outputTarget === "codex"} onClick={() => chooseOutputTarget("codex")}><BrandGlyph name="spark" /><span><strong>ChatGPT</strong><small>Codexで整える</small></span>{outputTarget === "codex" ? <Check size={17} strokeWidth={2.2} /> : <span>選ぶ</span>}</button>
            <button className={outputTarget === "claude" ? "is-selected" : ""} type="button" role="radio" aria-checked={outputTarget === "claude"} onClick={() => chooseOutputTarget("claude")}><BrandGlyph name="coach" /><span><strong>Claude</strong><small>Claude Codeで整える</small></span>{outputTarget === "claude" ? <Check size={17} strokeWidth={2.2} /> : <span>選ぶ</span>}</button>
            <button className={outputTarget === "gemini" ? "is-selected" : ""} type="button" role="radio" aria-checked={outputTarget === "gemini"} onClick={() => chooseOutputTarget("gemini")}><BrandGlyph name="loop" /><span><strong>Gemini</strong><small>Antigravity Flashで整える</small></span>{outputTarget === "gemini" ? <Check size={17} strokeWidth={2.2} /> : <span>選ぶ</span>}</button>
            <button className={outputTarget === "local" ? "is-selected" : ""} type="button" role="radio" aria-checked={outputTarget === "local"} onClick={() => chooseOutputTarget("local")}><BrandGlyph name="dx" /><span><strong>このPCのAI</strong><small>Gemma 4 E2Bで高速整形</small></span>{outputTarget === "local" ? <Check size={17} strokeWidth={2.2} /> : <span>選ぶ</span>}</button>
          </div>
        </section>
        <div className="settings-list direct-input-settings"><article><span className="setting-icon"><BrandGlyph name="move" /></span><div><h2>カーソル位置へ入力</h2><p>{directInputAllowed ? "ほかのアプリへ直接入力できます。" : "macOSのアクセシビリティ許可が必要です。"}</p></div><span className={directInputAllowed ? "setting-state state-permitted" : "setting-state state-unavailable"}>{directInputAllowed ? <Check size={15} strokeWidth={2.3} /> : <CircleAlert size={15} strokeWidth={2} />}{directInputAllowed ? "許可済み" : "未許可"}</span>{isMac ? <button className="outline-action" type="button" onClick={() => void (directInputAllowed ? openDirectInputSettings() : requestDirectInputPermission())}>{directInputAllowed ? "設定を開く" : "許可する"} <ExternalLink size={15} /></button> : <span />}</article></div>
        <div className="settings-list transcription-settings"><article><span className="setting-icon"><BrandGlyph name="work" /></span><div><h2>音声認識</h2><p>{transcription?.downloaded ? "日本語音声認識をこのPCで行います。" : "話した言葉を文字にする日本語モデルです。"}</p></div><span className={transcription?.downloaded ? "setting-state state-installed" : "setting-state state-unavailable"}>{transcription?.downloaded ? <Check size={15} strokeWidth={2.3} /> : <Download size={15} strokeWidth={2} />}{transcription?.downloaded ? "モデル取得済み" : downloadingTranscription ? "取得中" : transcription?.size || "未取得"}</span>{transcription?.downloaded ? <span /> : <button className="outline-action" type="button" onClick={() => void downloadTranscriptionModel()} disabled={downloadingTranscription}>{downloadingTranscription ? "取得中" : "モデルを取得"} <Download size={15} /></button>}</article></div>
        <div className="settings-list">{providers.map(({ id, label, glyph }) => { const status = providerDisplayState(id, false); const connecting = connectingProviders[id]; const loggedIn = connectedProviders[id] && statuses[id]?.authenticated; const unavailable = statuses[id]?.usability === "unavailable"; const detail = id === "codex" ? "GPT-5.6 Lunaで高速整形" : id === "gemini" ? "Gemini 3.6 Flash (Low)で高速整形" : unavailable ? "現在の契約ではClaude Codeを利用できません" : "Claude Haikuで高速整形"; return <article key={id}><span className="setting-icon"><BrandGlyph name={glyph} /></span><div><h2>{label}</h2><p>{detail}</p></div><span className={`setting-state ${status.className}`}>{connecting ? <span className="state-connecting-mark" aria-hidden="true" /> : unavailable ? <CircleAlert size={15} strokeWidth={2} /> : loggedIn ? <Check size={15} strokeWidth={2.3} /> : statuses[id]?.installed ? <span className="state-ring" aria-hidden="true" /> : <CircleAlert size={15} strokeWidth={2} />}{status.label}</span><button className="outline-action" type="button" onClick={() => void connect(id)} disabled={connecting}>{connecting ? "ログイン中" : loggedIn ? "再ログイン" : "ログインする"} {!connecting && <ExternalLink size={15} strokeWidth={1.9} />}</button></article>; })}<article><span className="setting-icon"><BrandGlyph name="dx" /></span><div><h2>ローカルAI</h2><p>{localReady ? "Gemma 4 E2BがこのPCで稼働中です。" : "Gemma 4 E2BをDOON Voice用に取得します。"}</p></div><span className={localReady ? "setting-state state-running" : "setting-state state-unavailable"}>{localReady ? <span className="state-live-dot" aria-hidden="true" /> : <WifiOff size={15} strokeWidth={2} />}{localReady ? "稼働中" : pullingLocalModel ? "取得中" : "未準備"}</span>{!local?.installed ? <button className="outline-action" type="button" onClick={() => void installOllama()} disabled={installingOllama}>{installingOllama ? "Ollamaを取得中" : "Ollamaを自動インストール"} <Download size={15} /></button> : !localModel?.installed ? <button className="outline-action" type="button" onClick={() => void pullModel()} disabled={pullingLocalModel}>{pullingLocalModel ? "取得中" : "Gemmaを取得"} <Download size={15} /></button> : <span />}</article><article className="shortcut-row"><span className="setting-icon"><BrandGlyph name="speed" /></span><div><h2>開始・停止キー</h2><p>{capturingShortcut ? "押した組み合わせを登録します。Escで取り消せます。" : "音声入力の開始と停止"}</p></div><button ref={shortcutButtonRef} className={capturingShortcut ? "shortcut-key is-capturing" : "shortcut-key"} type="button" onClick={() => void beginShortcutCapture()} aria-label="開始・停止キーを変更" aria-pressed={capturingShortcut}>{capturingShortcut ? "キーを押す" : shortcutLabel(shortcut, navigator.userAgent.includes("Mac"))}</button><button className="outline-action" type="button" onClick={() => void applyShortcut(DEFAULT_SHORTCUT)}>標準に戻す</button></article></div>{notice && <p className="notice" role="status">{notice}</p>}</section>}
    </section>

  </main>;
}

function VoiceOverlay() {
  const initial = new URLSearchParams(window.location.search).get("overlay");
  const [state, setState] = useState<OverlayState>(
    initial === "starting" || initial === "thinking" || initial === "done" || initial === "error" ? initial : "listening",
  );
  useEffect(() => {
    document.documentElement.classList.add("is-overlay");
    if (!isTauriApp()) {
      return () => document.documentElement.classList.remove("is-overlay");
    }
    let stopListening: (() => void) | undefined;
    void listen<string>("voice-overlay-state", (event) => {
      if (event.payload === "starting" || event.payload === "listening" || event.payload === "thinking" || event.payload === "done" || event.payload === "error") {
        setState(event.payload);
      }
    }).then((unlisten) => { stopListening = unlisten; });
    return () => {
      stopListening?.();
      document.documentElement.classList.remove("is-overlay");
    };
  }, []);
  const label = state === "starting" ? "準備しています" : state === "listening" ? "聞いています" : state === "thinking" ? "処理しています" : state === "done" ? "入力しました" : "入力できませんでした";
  const detail = state === "starting" ? "マイクを準備しています" : state === "listening" ? "音声を受け取っています" : state === "thinking" ? "音声を処理しています" : state === "done" ? "カーソル位置へ入力しました" : "DOON Voiceで内容を確認してください";
  return <main className={`voice-overlay is-${state}`} aria-live="assertive">
    <span className="voice-overlay-icon"><Mic size={25} strokeWidth={1.9} /></span>
    <span className="voice-overlay-copy"><small>DOON VOICE</small><strong>{label}</strong><em>{detail}</em></span>
    {state === "listening" ? <span className="voice-bars" aria-hidden="true"><i /><i /><i /><i /><i /></span> : state === "starting" || state === "thinking" ? <span className="overlay-spinner" aria-hidden="true" /> : state === "error" ? <X size={21} strokeWidth={2.2} /> : <Check size={21} strokeWidth={2.2} />}
  </main>;
}

export default function App() {
  return new URLSearchParams(window.location.search).has("overlay") ? <VoiceOverlay /> : <MainApp />;
}
