import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import { currentMonitor, getCurrentWindow, primaryMonitor } from "@tauri-apps/api/window";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { ArrowLeft, ArrowRight, Check, CircleAlert, CircleHelp, Download, ExternalLink, KeyRound, Mic, Plus, RefreshCw, Trash2, WifiOff, X } from "lucide-react";
import { FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode, useEffect, useRef, useState } from "react";
import { AudioRecorder, requestMicrophoneAccess, startAudioRecorder } from "./audio-recorder";
import { DEFAULT_OUTPUT_TARGET, DEFAULT_SELECTION_QUESTION_TARGET, isOutputTarget, isSelectionQuestionTarget, OutputTarget, outputTargetLabel, SelectionQuestionTarget } from "./output-target";
import { DEFAULT_SELECTION_QUESTION_SHORTCUT, DEFAULT_SHORTCUT, shortcutCaptureResult, shortcutLabel } from "./shortcut";
import { fitWindowPositionToWorkArea, fitWindowSizeToWorkArea } from "./window-fit";
import { createLocalStatusMonitor } from "./local-status";

type ProviderId = "codex" | "claude" | "gemini";
type ApiKeyStatus = Record<ProviderId, boolean>;
type View = "home" | "dictionary" | "settings" | "onboarding" | "guide";
type LocalModelChoice = "fast" | "accurate";
type LocalModel = { id: LocalModelChoice; name: string; size: string; installed: boolean };
type LocalLlmStatus = { installed: boolean; running: boolean; selected?: LocalModelChoice; models: LocalModel[] };
type TranscriptionStatus = { downloaded: boolean; name: string; size: string };
type InstallationKind = "ollama" | "local_model" | "transcription";
type InstallationProgress = { kind: InstallationKind; phase: string; completed: number; total: number; startedAt: number };
type MicrophonePermission = "granted" | "prompt" | "denied" | "unknown" | "unsupported";
type BrandGlyphName = "coach" | "dx" | "loop" | "move" | "spark" | "speed" | "system" | "work";
type BackgroundVoiceSnapshot = {
  state: "idle" | "starting" | "recording" | "processing";
  generation: number;
  transcript: string;
  output: string;
  message: string;
  clipboard_saved: boolean;
  recovery_pending: boolean;
};
type QuestionPhase = "ready" | "starting" | "recording" | "transcribing" | "answering" | "answer";
type SelectionQuestionEvent = { selection: string; question: string; answer: string };
type SelectionQuestionErrorEvent = { selection: string; question: string; error: string };
type SelectionQuestionPopupPayload = { selection: string; context_kind: "selection" | "screen"; question: string; answer?: string; error?: string; target: OutputTarget };

const MAX_DICTIONARY_TERMS = 100;
const MAX_TERM_CODEPOINTS = 80;

function dictionaryError(terms: readonly unknown[]): string {
  if (terms.length > MAX_DICTIONARY_TERMS) return `辞書は${MAX_DICTIONARY_TERMS}件までです。不要な言葉を削除してください`;
  if (terms.some((term) => typeof term !== "string" || !term.trim())) return "辞書に無効なデータがあります。該当する項目を削除してください";
  if (terms.some((term) => Array.from((term as string).trim()).length > MAX_TERM_CODEPOINTS)) return `辞書の言葉は${MAX_TERM_CODEPOINTS}文字までです。長すぎる言葉を削除してください`;
  return "";
}

const providers: Array<{ id: ProviderId; label: string; detail: string; glyph: BrandGlyphName }> = [
  { id: "codex", label: "ChatGPT", detail: "OpenAIのAPIキー（gpt-6-lunaで整形）", glyph: "spark" },
  { id: "claude", label: "Claude", detail: "AnthropicのAPIキー（Claude Haiku 5.5で整形）", glyph: "coach" },
  { id: "gemini", label: "Gemini", detail: "GoogleのAPIキー（Gemini 3.6 Flashで整形）", glyph: "loop" },
];

function BrandGlyph({ name, className = "" }: { name: BrandGlyphName; className?: string }) {
  // DOON独自絵柄は、ユーザー指定により操作記号ではなくブランド表現として維持する。
  return <img className={`brand-glyph ${className}`.trim()} src={`/brand/icons/doon-glyph-${name}.png`} alt="" aria-hidden="true" />;
}

function appInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauriApp()) return invoke<T>(command, args);
  const preview: Record<string, unknown> = {
    api_key_status: { codex: false, claude: false, gemini: false },
    local_llm_status: { installed: true, running: true, selected: "fast", models: [{ id: "fast", name: "Gemma 4 E2B", size: "約7.5 GB", installed: true }, { id: "accurate", name: "Gemma 4 E4B", size: "約9.2 GB", installed: false }] },
    transcription_status: { downloaded: true, name: "DOON Voice 高精度音声認識", size: "約574 MB" },
    direct_input_status: true,
    request_direct_input_permission: true,
    background_voice_status: { state: "idle", generation: 0, transcript: "", output: "", message: "", clipboard_saved: false, recovery_pending: false },
    capture_selected_text: "選択した文章について質問できます。",
    answer_selection_question: "選択した文章をもとにした回答です。",
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

async function fitMainWindowToWorkArea() {
  if (!isTauriApp()) return;
  try {
    const monitor = await currentMonitor() ?? await primaryMonitor();
    if (!monitor) return;
    const appWindow = getCurrentWindow();
    const scale = monitor.scaleFactor;
    const workArea = monitor.workArea.size.toLogical(scale);
    const currentSize = (await appWindow.innerSize()).toLogical(scale);
    const currentOuterSize = (await appWindow.outerSize()).toLogical(scale);
    const frameSize = {
      width: Math.max(0, currentOuterSize.width - currentSize.width),
      height: Math.max(0, currentOuterSize.height - currentSize.height),
    };
    const availableInnerSize = {
      width: Math.max(1, workArea.width - frameSize.width),
      height: Math.max(1, workArea.height - frameSize.height),
    };
    const fittedSize = fitWindowSizeToWorkArea(currentSize, availableInnerSize);
    const workAreaPosition = monitor.workArea.position.toLogical(scale);
    const resized = fittedSize.width !== currentSize.width || fittedSize.height !== currentSize.height;
    if (resized) await appWindow.setSize(new LogicalSize(fittedSize.width, fittedSize.height));
    const fittedOuterSize = resized
      ? (await appWindow.outerSize()).toLogical(scale)
      : currentOuterSize;
    const currentOuterPosition = (await appWindow.outerPosition()).toLogical(scale);
    const preferredPosition = resized
      ? {
          x: workAreaPosition.x + (workArea.width - fittedOuterSize.width) / 2,
          y: workAreaPosition.y + (workArea.height - fittedOuterSize.height) / 2,
        }
      : currentOuterPosition;
    const fittedPosition = fitWindowPositionToWorkArea(preferredPosition, fittedOuterSize, { position: workAreaPosition, size: workArea });
    if (fittedPosition.x !== currentOuterPosition.x || fittedPosition.y !== currentOuterPosition.y) {
      await appWindow.setPosition(new LogicalPosition(fittedPosition.x, fittedPosition.y));
    }
  } catch {
    console.warn("DOON Voiceの表示サイズを画面に合わせられませんでした");
  }
}

function savedShortcut() {
  try { return window.localStorage.getItem("doon-voice-shortcut") || DEFAULT_SHORTCUT; }
  catch { return DEFAULT_SHORTCUT; }
}

function savedSelectionQuestionShortcut() {
  try { return window.localStorage.getItem("doon-voice-selection-question-shortcut") || DEFAULT_SELECTION_QUESTION_SHORTCUT; }
  catch { return DEFAULT_SELECTION_QUESTION_SHORTCUT; }
}

function savedOutputTarget(): OutputTarget {
  try {
    const saved = window.localStorage.getItem("doon-voice-output-target");
    return isOutputTarget(saved) ? saved : DEFAULT_OUTPUT_TARGET;
  } catch { return DEFAULT_OUTPUT_TARGET; }
}

function savedSelectionQuestionTarget(): SelectionQuestionTarget {
  try {
    const saved = window.localStorage.getItem("doon-voice-selection-question-target");
    if (isSelectionQuestionTarget(saved)) return saved;
    const legacy = window.localStorage.getItem("doon-voice-output-target");
    return isSelectionQuestionTarget(legacy) ? legacy : DEFAULT_SELECTION_QUESTION_TARGET;
  } catch { return DEFAULT_SELECTION_QUESTION_TARGET; }
}

function savedDictionary(): { terms: unknown[]; unreadable: boolean } {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem("doon-voice-dictionary") ?? "[]");
    if (Array.isArray(value)) return { terms: value, unreadable: false };
  } catch { /* 読めない保存値は、利用者が削除するまで上書きしない */ }
  return { terms: [], unreadable: true };
}

function duration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes ? `${minutes}分 ${rest}秒` : `${rest}秒`;
}

function storageSize(bytes: number) {
  if (bytes < 1024 * 1024 * 1024) return `約${Math.round(bytes / (1024 * 1024))} MB`;
  return `約${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function installationProgressLabel(progress: InstallationProgress, now: number) {
  if (!progress.total) return progress.phase;
  const percentage = Math.min(100, Math.floor((progress.completed / progress.total) * 100));
  const elapsed = Math.max(1, Math.floor((now - progress.startedAt) / 1000));
  const remaining = progress.completed > 0 && elapsed >= 2
    ? Math.ceil((progress.total - progress.completed) / (progress.completed / elapsed))
    : 0;
  const estimate = remaining > 0 ? ` · 残り時間の目安 ${duration(remaining)}` : "";
  return `${storageSize(progress.completed)} / ${storageSize(progress.total)} · ${percentage}%${estimate}`;
}

async function microphonePermission(): Promise<MicrophonePermission> {
  if (!navigator.mediaDevices?.getUserMedia) return "unsupported";
  try {
    const result = await navigator.permissions?.query({ name: "microphone" as PermissionName });
    return result?.state ?? "unknown";
  } catch {
    return "unknown";
  }
}

type OverlayState = "starting" | "listening" | "thinking" | "done" | "error" | "hidden";

function MainApp() {
  const initialOutputTarget = useRef(savedOutputTarget()).current;
  const initialSelectionQuestionTarget = useRef(savedSelectionQuestionTarget()).current;
  const initialDictionary = useRef(savedDictionary()).current;
  // 初めて入れた人だけに案内を出す。既に使っている人（出力先の保存がある人）には自動で出さない。
  const [view, setView] = useState<View>(() =>
    window.localStorage.getItem("doon-voice-onboarding") === null && window.localStorage.getItem("doon-voice-output-target") === null ? "onboarding" : "home");
  const [onboardingStep, setOnboardingStep] = useState(0);
  const [apiKeys, setApiKeys] = useState<ApiKeyStatus | null>(null);
  const [local, setLocal] = useState<LocalLlmStatus | null>(null);
  const [installingOllama, setInstallingOllama] = useState(false);
  const [pullingLocalModel, setPullingLocalModel] = useState(false);
  const [downloadingTranscription, setDownloadingTranscription] = useState(false);
  const [installationProgress, setInstallationProgress] = useState<InstallationProgress | null>(null);
  const [installationNow, setInstallationNow] = useState(() => Date.now());
  const [microphonePermissionState, setMicrophonePermissionState] = useState<MicrophonePermission>("unknown");
  const [microphoneReady, setMicrophoneReady] = useState<boolean | null>(null);
  const [checkingMicrophone, setCheckingMicrophone] = useState(false);
  const [notice, setNotice] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const [refreshToast, setRefreshToast] = useState("");
  const refreshToastTimerRef = useRef<number | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [latestAppVersion, setLatestAppVersion] = useState<string | null>(null);
  const [updateCheckedAt, setUpdateCheckedAt] = useState<number | null>(null);
  const [updateCheckError, setUpdateCheckError] = useState("");
  const [updatingApp, setUpdatingApp] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [terms, setTerms] = useState<unknown[]>(initialDictionary.terms);
  const [unreadableDictionary, setUnreadableDictionary] = useState(initialDictionary.unreadable);
  const [termDraft, setTermDraft] = useState("");
  const [termError, setTermError] = useState("");
  const [shortcut, setShortcut] = useState(savedShortcut);
  const [selectionQuestionShortcut, setSelectionQuestionShortcut] = useState(savedSelectionQuestionShortcut);
  const [capturingShortcut, setCapturingShortcut] = useState(false);
  const [capturingSelectionQuestionShortcut, setCapturingSelectionQuestionShortcut] = useState(false);
  const [outputTarget, setOutputTarget] = useState<OutputTarget>(initialOutputTarget);
  const outputTargetRef = useRef(initialOutputTarget);
  const [selectionQuestionTarget, setSelectionQuestionTarget] = useState<SelectionQuestionTarget>(initialSelectionQuestionTarget);
  const selectionQuestionTargetRef = useRef(initialSelectionQuestionTarget);
  const configQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [configSaving, setConfigSaving] = useState(0);
  const [configError, setConfigError] = useState("");
  const [transcription, setTranscription] = useState<TranscriptionStatus | null>(null);
  const [transcript, setTranscript] = useState("");
  const [output, setOutput] = useState("");
  const [processing, setProcessing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [clipboardSaved, setClipboardSaved] = useState(false);
  const [recoveryPending, setRecoveryPending] = useState(false);
  const [resultActionPending, setResultActionPending] = useState(false);
  const resultActionPendingRef = useRef(false);
  const resultGenerationRef = useRef(0);
  const voiceStateRef = useRef<BackgroundVoiceSnapshot["state"]>("idle");
  const [directInputAllowed, setDirectInputAllowed] = useState<boolean | null>(null);
  const [keyDrafts, setKeyDrafts] = useState<Record<ProviderId, string>>({ codex: "", claude: "", gemini: "" });
  const [savingKeys, setSavingKeys] = useState<Record<ProviderId, boolean>>({ codex: false, claude: false, gemini: false });
  const [confirmingKeyDelete, setConfirmingKeyDelete] = useState<ProviderId | null>(null);
  // APIキーの確認結果は押したボタンの行に出す。設定画面の最下部だと画面外になり、押しても反応がないように見える
  const [providerNotices, setProviderNotices] = useState<Partial<Record<ProviderId, { text: string; error: boolean }>>>({});
  const [questionOpen, setQuestionOpen] = useState(false);
  const [questionSelection, setQuestionSelection] = useState("");
  const [questionDraft, setQuestionDraft] = useState("");
  const [questionAnswer, setQuestionAnswer] = useState("");
  const [questionError, setQuestionError] = useState("");
  const [questionPhase, setQuestionPhase] = useState<QuestionPhase>("ready");
  const startRef = useRef<number | null>(null);
  const registeredShortcutRef = useRef<string | null>(null);
  const registeredSelectionQuestionShortcutRef = useRef<string | null>(null);
  const capturedFromShortcutRef = useRef<string | null>(null);
  const capturedFromSelectionQuestionShortcutRef = useRef<string | null>(null);
  const shortcutCaptureActiveRef = useRef(false);
  const selectionQuestionShortcutCaptureActiveRef = useRef(false);
  const shortcutOperationRef = useRef(0);
  const selectionQuestionShortcutOperationRef = useRef(0);
  const shortcutButtonRef = useRef<HTMLButtonElement | null>(null);
  const selectionQuestionShortcutButtonRef = useRef<HTMLButtonElement | null>(null);
  const pullingLocalModelRef = useRef(false);
  const downloadingTranscriptionRef = useRef(false);
  const questionInputRef = useRef<HTMLTextAreaElement | null>(null);
  const questionRecorderRef = useRef<AudioRecorder | null>(null);
  const questionOperationRef = useRef(0);
  const questionComposingRef = useRef(false);
  const localStatusMonitorRef = useRef<ReturnType<typeof createLocalStatusMonitor<LocalLlmStatus>> | null>(null);

  useEffect(() => {
    const monitor = createLocalStatusMonitor(() => appInvoke<LocalLlmStatus>("local_llm_status"), setLocal);
    localStatusMonitorRef.current = monitor;
    void monitor.refresh();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    if (isTauriApp()) {
      void listen<LocalLlmStatus>("local-llm-status", (event) => monitor.accept(event.payload)).then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      }).catch(() => undefined); // Bounded periodic probes remain available.
    }
    const timer = window.setInterval(() => { void monitor.refresh(); }, 5000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      unlisten?.();
      monitor.dispose();
      if (localStatusMonitorRef.current === monitor) localStatusMonitorRef.current = null;
    };
  }, []);

  useEffect(() => { void refreshAll(); void fitMainWindowToWorkArea(); }, []);
  useEffect(() => {
    if (!isTauriApp()) {
      setAppVersion("開発版");
      return;
    }
    void getVersion().then(setAppVersion).catch(() => setAppVersion("確認できません"));
  }, []);
  useEffect(() => () => {
    if (refreshToastTimerRef.current !== null) window.clearTimeout(refreshToastTimerRef.current);
  }, []);
  useEffect(() => { window.localStorage.removeItem("doon-voice-history"); }, []);
  useEffect(() => { window.scrollTo(0, 0); }, [view]);
  useEffect(() => {
    const refreshPermission = () => {
      void appInvoke<boolean>("direct_input_status").then(setDirectInputAllowed).catch(() => undefined);
    };
    const refreshOnFocus = () => { void refreshAll(); void microphonePermission().then(setMicrophonePermissionState); };
    window.addEventListener("focus", refreshOnFocus);
    // macOSのシステム設定で許可を切り替えて戻ってきた場合、WebViewの
    // focusイベントだけでは通知されないことがあるため定期的に再確認する。
    const timer = window.setInterval(refreshPermission, 1000);
    return () => {
      window.removeEventListener("focus", refreshOnFocus);
      window.clearInterval(timer);
    };
  }, []);
  useEffect(() => { void microphonePermission().then(setMicrophonePermissionState); }, []);
  useEffect(() => {
    if (!installationProgress) return;
    const timer = window.setInterval(() => setInstallationNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [installationProgress]);
  useEffect(() => {
    if (!isTauriApp()) return;
    let stopListening: (() => void) | undefined;
    let stopQuestionListening: (() => void) | undefined;
    let stopQuestionErrorListening: (() => void) | undefined;
    let stopInstallationListening: (() => void) | undefined;
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
    void listen<SelectionQuestionEvent>("selection-question-answer", (event) => {
      questionOperationRef.current += 1;
      setQuestionSelection(event.payload.selection);
      setQuestionDraft(event.payload.question);
      setQuestionAnswer(event.payload.answer);
      setQuestionError("");
      setQuestionPhase("answer");
      setQuestionOpen(true);
      focusQuestionInput();
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stopQuestionListening = unlisten;
    }).catch(() => setNotice("選択文への回答を表示できませんでした"));
    void listen<SelectionQuestionErrorEvent>("selection-question-error", (event) => {
      questionOperationRef.current += 1;
      setQuestionSelection(event.payload.selection);
      setQuestionDraft(event.payload.question);
      setQuestionAnswer("");
      setQuestionError(event.payload.error);
      setQuestionPhase("ready");
      setQuestionOpen(true);
      focusQuestionInput();
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stopQuestionErrorListening = unlisten;
    }).catch(() => setNotice("選択文への質問エラーを表示できませんでした"));
    void listen<Omit<InstallationProgress, "startedAt">>("installation-progress", (event) => {
      setInstallationProgress((current) => ({ ...event.payload, startedAt: current?.kind === event.payload.kind ? current.startedAt : Date.now() }));
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stopInstallationListening = unlisten;
    }).catch(() => setNotice("取得状況を表示できませんでした"));
    return () => { disposed = true; stopListening?.(); stopQuestionListening?.(); stopQuestionErrorListening?.(); stopInstallationListening?.(); };
  }, []);
  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => {
      if (startRef.current) setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 250);
    return () => window.clearInterval(timer);
  }, [recording]);
  useEffect(() => {
    if (capturingShortcut) shortcutButtonRef.current?.focus();
    if (capturingSelectionQuestionShortcut) selectionQuestionShortcutButtonRef.current?.focus();
  }, [capturingShortcut, capturingSelectionQuestionShortcut]);
  useEffect(() => {
    if (!unreadableDictionary) window.localStorage.setItem("doon-voice-dictionary", JSON.stringify(terms));
  }, [terms, unreadableDictionary]);
  useEffect(() => {
    if (unreadableDictionary || dictionaryError(terms)) return;
    void saveConfiguration(undefined, undefined, terms);
  }, [terms, unreadableDictionary]);

  function saveConfiguration(target: OutputTarget | undefined, questionTarget: SelectionQuestionTarget | undefined, dictionary: unknown[], afterSaved?: () => Promise<void>): Promise<boolean> {
    setConfigSaving((current) => current + 1);
    const job = configQueueRef.current.then(async () => {
      const error = dictionaryError(dictionary);
      if (error) throw new Error(error);
      // A shortcut can start recording while an earlier configuration awaits its ACK.
      if ((target !== undefined || questionTarget !== undefined) && voiceStateRef.current !== "idle") {
        setNotice("音声入力が終わってからAIを変更してください");
        return false;
      }
      const nextTarget = target ?? outputTargetRef.current;
      const nextQuestionTarget = questionTarget ?? selectionQuestionTargetRef.current;
      await appInvoke("configure_background_voice", { target: nextTarget, selectionQuestionTarget: nextQuestionTarget, dictionary });
      outputTargetRef.current = nextTarget;
      setOutputTarget(nextTarget);
      selectionQuestionTargetRef.current = nextQuestionTarget;
      setSelectionQuestionTarget(nextQuestionTarget);
      window.localStorage.setItem("doon-voice-output-target", nextTarget);
      window.localStorage.setItem("doon-voice-selection-question-target", nextQuestionTarget);
      setConfigError("");
      if (afterSaved) await afterSaved();
      return true;
    });
    const settled = job.catch((error) => {
      setConfigError(errorMessage(error, "音声入力の設定を保存できませんでした"));
      return false;
    }).finally(() => setConfigSaving((current) => current - 1));
    configQueueRef.current = settled.then(() => undefined);
    return settled;
  }

  function applyBackgroundVoiceSnapshot(snapshot: BackgroundVoiceSnapshot) {
    if (snapshot.generation < resultGenerationRef.current) return;
    resultGenerationRef.current = snapshot.generation;
    voiceStateRef.current = snapshot.state;
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

  function showRefreshToast(message: string) {
    if (refreshToastTimerRef.current !== null) window.clearTimeout(refreshToastTimerRef.current);
    setRefreshToast(message);
    refreshToastTimerRef.current = window.setTimeout(() => {
      setRefreshToast("");
      refreshToastTimerRef.current = null;
    }, 3500);
  }

  async function refreshAll(manual = false) {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      await Promise.all([
        appInvoke<ApiKeyStatus>("api_key_status").then(setApiKeys).catch(() => setApiKeys(null)),
        localStatusMonitorRef.current?.refresh(),
        appInvoke<TranscriptionStatus>("transcription_status").then(setTranscription).catch(() => setTranscription(null)),
        appInvoke<boolean>("direct_input_status").then(setDirectInputAllowed).catch(() => setDirectInputAllowed(null)),
        microphonePermission().then((status) => {
          setMicrophonePermissionState(status);
          // 許可を確かめられない環境（"unknown"）では、確認済みの結果を消さない。取り消された時だけ確認し直す。
          if (status === "denied" || status === "prompt") setMicrophoneReady(null);
        }).catch(() => { setMicrophonePermissionState("unknown"); setMicrophoneReady(null); }),
      ]);
      if (manual) showRefreshToast("状態を更新しました");
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }

  async function waitForLocalLlmStart() {
    for (let attempt = 0; attempt < 15; attempt += 1) {
      try {
        const status = await localStatusMonitorRef.current?.refresh();
        if (status?.running) return true;
      } catch {
        setLocal(null);
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 1000));
    }
    return false;
  }

  async function findAppUpdate() {
    const update = await check({ timeout: 30_000 });
    setUpdateCheckedAt(Date.now());
    setUpdateCheckError("");
    setLatestAppVersion(update?.version ?? appVersion);
    return update;
  }

  async function updateApp() {
    if (updatingApp) return;
    if (busy || resultActionPending || recoveryPending) {
      setNotice("音声入力の処理が終わってから更新してください");
      return;
    }
    if (!isTauriApp()) {
      setNotice("更新の確認はインストール済みのアプリ版で使えます");
      return;
    }
    setUpdatingApp(true);
    setNotice("更新を確認しています");
    try {
      const update = await findAppUpdate();
      if (!update) {
        showRefreshToast("DOON Voiceは最新版です");
        return;
      }
      setNotice(`v${update.version}を取得しています`);
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") setNotice(`v${update.version}を取得しています`);
        if (event.event === "Finished") setNotice(`v${update.version}を適用しています`);
      }, { timeout: 120_000, restartAfterInstall: true });
      setNotice(`v${update.version}を適用しました。再起動します`);
      await relaunch();
    } catch (error) {
      const message = errorMessage(error, "更新を確認できませんでした。時間をおいてもう一度試してください");
      setUpdateCheckError(message);
      setNotice(message);
    } finally {
      setUpdatingApp(false);
    }
  }

  async function toggleRecording() {
    try {
      await appInvoke("toggle_background_voice");
    } catch (error) {
      setNotice(errorMessage(error, "音声入力を切り替えられませんでした"));
    }
  }

  function focusQuestionInput() {
    window.setTimeout(() => questionInputRef.current?.focus(), 0);
  }

  async function openSelectionQuestion() {
    if (busy || questionPhase === "starting" || questionPhase === "recording" || questionPhase === "transcribing" || questionPhase === "answering") return;
    const operation = ++questionOperationRef.current;
    try {
      const selection = (await appInvoke<string>("capture_selected_text")).trim();
      if (!selection) throw new Error("質問したい文章を選択してコピーしてから、もう一度試してください");
      if (operation !== questionOperationRef.current) return;
      setQuestionSelection(selection);
      setQuestionDraft("");
      setQuestionAnswer("");
      setQuestionError("");
      setQuestionPhase("ready");
      setQuestionOpen(true);
      focusQuestionInput();
    } catch (error) {
      if (operation === questionOperationRef.current) setNotice(errorMessage(error, "質問したい文章を選択してコピーしてから、もう一度試してください"));
    }
  }

  async function openScreenQuestion() {
    if (busy || questionPhase === "starting" || questionPhase === "recording" || questionPhase === "transcribing" || questionPhase === "answering") return;
    const operation = ++questionOperationRef.current;
    try {
      await appInvoke("open_frontmost_screen_question", { target: selectionQuestionTargetRef.current });
    } catch (error) {
      if (operation === questionOperationRef.current) setNotice(errorMessage(error, "前面の画面を読み取れませんでした"));
    }
  }

  function closeSelectionQuestion() {
    questionOperationRef.current += 1;
    const recorder = questionRecorderRef.current;
    questionRecorderRef.current = null;
    if (recorder) void recorder.stop().catch(() => undefined);
    setQuestionOpen(false);
    setQuestionError("");
    setQuestionPhase("ready");
  }

  async function askSelectionQuestion(question = questionDraft) {
    const normalizedQuestion = question.trim();
    if (!normalizedQuestion || questionPhase === "starting" || questionPhase === "recording" || questionPhase === "transcribing" || questionPhase === "answering") return;
    if (outputTarget === "raw") {
      setQuestionError("回答にはChatGPT、Claude、Gemini、またはこのPCのAIを選んでください");
      return;
    }
    const operation = ++questionOperationRef.current;
    setQuestionError("");
    setQuestionAnswer("");
    setQuestionDraft("");
    setQuestionPhase("answering");
    try {
      const answer = await appInvoke<string>("answer_selection_question", {
        target: selectionQuestionTargetRef.current,
        selection: questionSelection,
        question: normalizedQuestion,
      });
      if (operation !== questionOperationRef.current) return;
      setQuestionAnswer(answer);
      setQuestionPhase("answer");
      focusQuestionInput();
    } catch (error) {
      if (operation !== questionOperationRef.current) return;
      setQuestionDraft(normalizedQuestion);
      setQuestionError(errorMessage(error, "回答を作れませんでした"));
      setQuestionPhase("ready");
      focusQuestionInput();
    }
  }

  async function toggleQuestionVoice() {
    if (questionPhase === "starting" || questionPhase === "answering" || questionPhase === "transcribing") return;
    if (questionPhase === "recording") {
      const recorder = questionRecorderRef.current;
      questionRecorderRef.current = null;
      if (!recorder) return;
      const operation = ++questionOperationRef.current;
      setQuestionPhase("transcribing");
      setQuestionError("");
      try {
        const audio = await recorder.stop();
        const dictionary = terms.filter((term): term is string => typeof term === "string");
        const question = await appInvoke<string>("transcribe_voice", { audio: Array.from(audio), dictionary });
        if (operation !== questionOperationRef.current) return;
        setQuestionDraft(question);
        setQuestionPhase("ready");
        window.setTimeout(() => { void askSelectionQuestion(question); }, 0);
      } catch (error) {
        if (operation !== questionOperationRef.current) return;
        setQuestionError(errorMessage(error, "質問の音声を読み取れませんでした"));
        setQuestionPhase("ready");
        focusQuestionInput();
      }
      return;
    }
    const operation = ++questionOperationRef.current;
    setQuestionError("");
    setQuestionPhase("starting");
    try {
      const recorder = await startAudioRecorder();
      if (operation !== questionOperationRef.current) {
        void recorder.stop().catch(() => undefined);
        return;
      }
      questionRecorderRef.current = recorder;
      setQuestionPhase("recording");
    } catch (error) {
      if (operation !== questionOperationRef.current) return;
      setQuestionError(errorMessage(error, "質問用のマイクを開始できませんでした"));
      setQuestionPhase("ready");
    }
  }

  async function copyQuestionAnswer() {
    if (!questionAnswer) return;
    try {
      await navigator.clipboard.writeText(questionAnswer);
      setQuestionError("");
      showRefreshToast("回答をクリップボードにコピーしました");
    } catch {
      setQuestionError("回答をコピーできませんでした。文章を選択してコピーしてください");
    }
  }

  async function pasteQuestionAnswer() {
    if (!questionAnswer) return;
    try {
      await appInvoke("paste_question_answer", { text: questionAnswer });
    } catch (error) {
      setQuestionError(errorMessage(error, "回答を入力できませんでした。コピーして貼り付けてください"));
    }
  }

  function questionKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (questionComposingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    void askSelectionQuestion();
  }

  async function applyShortcut(next: string, notify = true) {
    const operation = ++shortcutOperationRef.current;
    shortcutCaptureActiveRef.current = false;
    setCapturingShortcut(false);
    const previous = registeredShortcutRef.current;
    try {
      if (isTauriApp()) {
        await appInvoke("set_voice_shortcut", { shortcut: next });
        if (operation !== shortcutOperationRef.current) return;
        registeredShortcutRef.current = next;
      }
      window.localStorage.setItem("doon-voice-shortcut", next);
      setShortcut(next);
      capturedFromShortcutRef.current = null;
      if (notify) showRefreshToast(`開始・停止キーを ${shortcutLabel(next, navigator.userAgent.includes("Mac"))} に変更しました`);
    } catch {
      if (operation !== shortcutOperationRef.current) return;
      const restore = previous ?? capturedFromShortcutRef.current;
      if (restore && isTauriApp()) {
        try { await appInvoke("set_voice_shortcut", { shortcut: restore }); registeredShortcutRef.current = restore; }
        catch { registeredShortcutRef.current = null; setNotice("元の開始・停止キーを復元できませんでした。設定からキーを登録し直してください"); capturedFromShortcutRef.current = null; return; }
      }
      capturedFromShortcutRef.current = null;
      setNotice("そのキーは他のアプリかOSが使っています。別の組み合わせを選んでください");
    }
  }

  async function applySelectionQuestionShortcut(next: string, notify = true) {
    const operation = ++selectionQuestionShortcutOperationRef.current;
    selectionQuestionShortcutCaptureActiveRef.current = false;
    setCapturingSelectionQuestionShortcut(false);
    const previous = registeredSelectionQuestionShortcutRef.current;
    try {
      if (isTauriApp()) {
        await appInvoke("set_selection_question_shortcut", { shortcut: next });
        if (operation !== selectionQuestionShortcutOperationRef.current) return;
        registeredSelectionQuestionShortcutRef.current = next;
      }
      window.localStorage.setItem("doon-voice-selection-question-shortcut", next);
      setSelectionQuestionShortcut(next);
      capturedFromSelectionQuestionShortcutRef.current = null;
      if (notify) showRefreshToast(`選択した文章を質問するキーを ${shortcutLabel(next, navigator.userAgent.includes("Mac"))} に変更しました`);
    } catch {
      if (operation !== selectionQuestionShortcutOperationRef.current) return;
      const restore = previous ?? capturedFromSelectionQuestionShortcutRef.current;
      if (restore && isTauriApp()) {
        try { await appInvoke("set_selection_question_shortcut", { shortcut: restore }); registeredSelectionQuestionShortcutRef.current = restore; }
        catch { registeredSelectionQuestionShortcutRef.current = null; setNotice("元の質問用キーを復元できませんでした。設定からキーを登録し直してください"); capturedFromSelectionQuestionShortcutRef.current = null; return; }
      }
      capturedFromSelectionQuestionShortcutRef.current = null;
      setNotice("そのキーは他のアプリかOSが使っています。別の組み合わせを選んでください");
    }
  }

  useEffect(() => { void applyShortcut(shortcut, false); void applySelectionQuestionShortcut(selectionQuestionShortcut, false); }, []);

  async function beginShortcutCapture() {
    if (shortcutCaptureActiveRef.current || selectionQuestionShortcutCaptureActiveRef.current) return;
    const operation = ++shortcutOperationRef.current;
    const previous = registeredShortcutRef.current ?? shortcut;
    capturedFromShortcutRef.current = previous;
    shortcutCaptureActiveRef.current = true;
    try {
      if (isTauriApp()) { await appInvoke("clear_voice_shortcut"); if (operation !== shortcutOperationRef.current) return; registeredShortcutRef.current = null; }
      if (shortcutCaptureActiveRef.current) setCapturingShortcut(true);
    } catch { if (operation !== shortcutOperationRef.current) return; shortcutCaptureActiveRef.current = false; capturedFromShortcutRef.current = null; setNotice("開始・停止キーの変更を始められませんでした。もう一度試してください"); }
  }

  async function beginSelectionQuestionShortcutCapture() {
    if (shortcutCaptureActiveRef.current || selectionQuestionShortcutCaptureActiveRef.current) return;
    const operation = ++selectionQuestionShortcutOperationRef.current;
    const previous = registeredSelectionQuestionShortcutRef.current ?? selectionQuestionShortcut;
    capturedFromSelectionQuestionShortcutRef.current = previous;
    selectionQuestionShortcutCaptureActiveRef.current = true;
    try {
      if (isTauriApp()) { await appInvoke("clear_selection_question_shortcut"); if (operation !== selectionQuestionShortcutOperationRef.current) return; registeredSelectionQuestionShortcutRef.current = null; }
      if (selectionQuestionShortcutCaptureActiveRef.current) setCapturingSelectionQuestionShortcut(true);
    } catch { if (operation !== selectionQuestionShortcutOperationRef.current) return; selectionQuestionShortcutCaptureActiveRef.current = false; capturedFromSelectionQuestionShortcutRef.current = null; setNotice("質問用キーの変更を始められませんでした。もう一度試してください"); }
  }

  function cancelShortcutCapture() {
    if (shortcutCaptureActiveRef.current) {
      shortcutOperationRef.current += 1; shortcutCaptureActiveRef.current = false;
      const previous = capturedFromShortcutRef.current; setCapturingShortcut(false);
      if (previous) void applyShortcut(previous, false);
    }
    if (selectionQuestionShortcutCaptureActiveRef.current) {
      selectionQuestionShortcutOperationRef.current += 1; selectionQuestionShortcutCaptureActiveRef.current = false;
      const previous = capturedFromSelectionQuestionShortcutRef.current; setCapturingSelectionQuestionShortcut(false);
      if (previous) void applySelectionQuestionShortcut(previous, false);
    }
  }

  function navigate(next: View) {
    cancelShortcutCapture();
    if (view === "onboarding" && next !== "onboarding" && window.localStorage.getItem("doon-voice-onboarding") === null) {
      window.localStorage.setItem("doon-voice-onboarding", "later");
    }
    setView(next);
  }

  function openOnboarding() {
    setOnboardingStep(0);
    navigate("onboarding");
  }

  function finishOnboarding() {
    window.localStorage.setItem("doon-voice-onboarding", "done");
    navigate("home");
    showRefreshToast("はじめの設定が終わりました");
  }

  useEffect(() => {
    window.addEventListener("blur", cancelShortcutCapture);
    return () => {
      window.removeEventListener("blur", cancelShortcutCapture);
      if (shortcutCaptureActiveRef.current && capturedFromShortcutRef.current) void appInvoke("set_voice_shortcut", { shortcut: capturedFromShortcutRef.current });
      if (selectionQuestionShortcutCaptureActiveRef.current && capturedFromSelectionQuestionShortcutRef.current) void appInvoke("set_selection_question_shortcut", { shortcut: capturedFromSelectionQuestionShortcutRef.current });
    };
  }, []);

  useEffect(() => {
    if (!capturingShortcut && !capturingSelectionQuestionShortcut) return;
    const captureShortcut = (event: KeyboardEvent) => {
      const captureInput = shortcutCaptureActiveRef.current;
      const captureQuestion = selectionQuestionShortcutCaptureActiveRef.current;
      if (!captureInput && !captureQuestion) return;
      if (event.repeat) return;
      event.preventDefault(); event.stopPropagation();
      const result = shortcutCaptureResult(event);
      if (result.kind === "cancel") { cancelShortcutCapture(); return; }
      if (result.kind === "invalid") { setNotice("Control、Option/Alt、Commandのいずれかを一緒に押してください（Shiftは追加でのみ使えます）"); return; }
      if (captureInput) void applyShortcut(result.shortcut);
      else void applySelectionQuestionShortcut(result.shortcut);
    };
    window.addEventListener("keydown", captureShortcut, true);
    return () => window.removeEventListener("keydown", captureShortcut, true);
  }, [capturingShortcut, capturingSelectionQuestionShortcut]);

  function setProviderNotice(provider: ProviderId, text: string | null, error = false) {
    setProviderNotices((current) => ({ ...current, [provider]: text === null ? undefined : { text, error } }));
  }

  async function saveApiKey(provider: ProviderId) {
    const key = keyDrafts[provider].trim();
    if (!key) {
      setProviderNotice(provider, "APIキーを入力してください", true);
      return;
    }
    setSavingKeys((current) => ({ ...current, [provider]: true }));
    setProviderNotice(provider, null);
    try {
      await appInvoke("save_api_key", { provider, key });
      setKeyDrafts((current) => ({ ...current, [provider]: "" }));
      setApiKeys((current) => ({ ...(current ?? { codex: false, claude: false, gemini: false }), [provider]: true }));
      showRefreshToast(`${outputTargetLabel(provider)}のAPIキーを保存しました`);
    } catch (error) {
      setProviderNotice(provider, errorMessage(error, "APIキーを確認できませんでした"), true);
      window.requestAnimationFrame(() => document.getElementById(`api-key-notice-${provider}`)?.scrollIntoView({ block: "nearest" }));
    } finally {
      setSavingKeys((current) => ({ ...current, [provider]: false }));
    }
  }

  async function deleteApiKey(provider: ProviderId) {
    if (confirmingKeyDelete !== provider) {
      setConfirmingKeyDelete(provider);
      return;
    }
    setConfirmingKeyDelete(null);
    try {
      await appInvoke("delete_api_key", { provider });
      setApiKeys((current) => ({ ...(current ?? { codex: false, claude: false, gemini: false }), [provider]: false }));
      setProviderNotice(provider, null);
      showRefreshToast(`${outputTargetLabel(provider)}のAPIキーを削除しました`);
    } catch (error) {
      setProviderNotice(provider, errorMessage(error, "APIキーを削除できませんでした"), true);
    }
  }

  function chooseOutputTarget(target: OutputTarget) {
    if (voiceStateRef.current !== "idle") {
      setNotice("音声入力が終わってからAIを変更してください");
      return;
    }
    if (unreadableDictionary) { setConfigError("保存された辞書を読み取れません。辞書画面で確認してください"); return; }
    void saveConfiguration(target, undefined, terms).then((saved) => {
      if (saved) showRefreshToast(target === "raw" ? "AIなしの音声入力に変更しました" : `文章を整えるAIを ${outputTargetLabel(target)} に変更しました`);
    });
  }

  function chooseSelectionQuestionTarget(target: SelectionQuestionTarget) {
    if (voiceStateRef.current !== "idle") {
      setNotice("音声入力が終わってからAIを変更してください");
      return;
    }
    if (unreadableDictionary) { setConfigError("保存された辞書を読み取れません。辞書画面で確認してください"); return; }
    void saveConfiguration(undefined, target, terms).then((saved) => {
      if (saved) showRefreshToast(`選択文・画面を質問するAIを ${outputTargetLabel(target)} に変更しました`);
    });
  }

  async function installOllama() {
    if (installingOllama) return;
    setInstallingOllama(true);
    setInstallationProgress({ kind: "ollama", phase: "ローカルAIを確認しています", completed: 0, total: 0, startedAt: Date.now() });
    setNotice("ローカルAIを準備しています。完了までこの画面を開いたままにしてください");
    try {
      await appInvoke("open_local_llm_install");
      if (await waitForLocalLlmStart()) {
        showRefreshToast("ローカルAIを準備しました。Ollamaアカウントは不要です。Gemmaを取得できます");
      } else {
        setNotice("ローカルAIの起動に時間がかかっています。少し待ってから状態を更新してください");
      }
    } catch (error) {
      setNotice(errorMessage(error, "ローカルAIを準備できませんでした。ネット接続を確認して、もう一度試してください"));
    } finally {
      setInstallingOllama(false);
      setInstallationProgress(null);
    }
  }

  async function requestMicrophonePermission() {
    if (checkingMicrophone) return;
    setCheckingMicrophone(true);
    try {
      await requestMicrophoneAccess();
      await appInvoke("check_microphone");
      setMicrophonePermissionState("granted");
      setMicrophoneReady(true);
      showRefreshToast("マイクの許可と接続を確認しました");
    } catch (error) {
      const status = await microphonePermission();
      setMicrophonePermissionState(status);
      setMicrophoneReady(false);
      setNotice(errorMessage(error, "マイクを使える状態にできませんでした。OSのマイク設定と接続を確認してください"));
    } finally {
      setCheckingMicrophone(false);
    }
  }

  async function openDirectInputSettings() {
    try { await appInvoke("open_direct_input_settings"); setNotice("アクセシビリティ設定を開きました。一覧のDOON Voiceをオンにしてください"); }
    catch (error) { setNotice(errorMessage(error, "直接入力の設定を開けませんでした")); }
  }

  async function requestDirectInputPermission() {
    try {
      const allowed = await appInvoke<boolean>("request_direct_input_permission");
      setDirectInputAllowed(allowed);
      if (allowed) {
        showRefreshToast("カーソル位置への入力を許可しました");
      } else {
        setNotice("前の版の許可を外し、今のDOON Voiceを一覧に加えました。開いた設定で、DOON Voiceをオンにしてください");
      }
    } catch (error) {
      setNotice(errorMessage(error, "直接入力の許可を確認できませんでした"));
    }
  }

  async function pullModel() {
    if (pullingLocalModelRef.current) return;
    pullingLocalModelRef.current = true;
    setPullingLocalModel(true);
    setInstallationProgress({ kind: "local_model", phase: "モデルの取得を準備しています", completed: 0, total: 0, startedAt: Date.now() });
    const modelName = localModel?.name ?? "このPCのAI";
    setNotice(`${modelName}を取得しています。完了までこの画面を開いたままにしてください`);
    try {
      await appInvoke("pull_local_model", { choice: local?.selected ?? "fast" });
      await refreshAll();
      showRefreshToast(`${modelName}を準備しました`);
    } catch (error) {
      setNotice(errorMessage(error, `${modelName}を取得できませんでした`));
    } finally {
      pullingLocalModelRef.current = false;
      setPullingLocalModel(false);
      setInstallationProgress(null);
    }
  }

  async function chooseLocalModel(choice: LocalModelChoice) {
    if (local?.selected === choice) return;
    if (voiceStateRef.current !== "idle") {
      setNotice("音声入力が終わってから変更してください");
      return;
    }
    try {
      await appInvoke("set_local_model", { choice });
      setLocal((current) => current ? { ...current, selected: choice } : current);
      const chosen = local?.models.find((model) => model.id === choice);
      showRefreshToast(`このPCのAIを${choice === "fast" ? "速さ優先" : "正確さ優先"}（${chosen?.name ?? ""}）に変更しました`);
    } catch (error) {
      setNotice(errorMessage(error, "このPCのAIを変更できませんでした"));
    }
  }

  async function downloadTranscriptionModel() {
    if (downloadingTranscriptionRef.current) return;
    downloadingTranscriptionRef.current = true;
    setDownloadingTranscription(true);
    setInstallationProgress({ kind: "transcription", phase: "モデルの取得を準備しています", completed: 0, total: 0, startedAt: Date.now() });
    setNotice("日本語音声認識モデルを取得しています。完了までこの画面を開いたままにしてください");
    try {
      await appInvoke("download_transcription_model");
      await refreshAll();
      showRefreshToast("日本語音声認識モデルを準備しました");
    } catch (error) {
      setNotice(errorMessage(error, "音声認識モデルを取得できませんでした"));
    } finally {
      downloadingTranscriptionRef.current = false;
      setDownloadingTranscription(false);
      setInstallationProgress(null);
    }
  }

  async function copyResult(text: string) {
    if (!text || resultActionPendingRef.current || voiceStateRef.current !== "idle") return;
    const generation = resultGenerationRef.current;
    resultActionPendingRef.current = true;
    setResultActionPending(true);
    try {
      await navigator.clipboard.writeText(text);
      if (generation !== resultGenerationRef.current) return;
      try {
        await appInvoke("ack_voice_result", { generation });
        if (generation !== resultGenerationRef.current) return;
        setClipboardSaved(true);
        setRecoveryPending(false);
        showRefreshToast("クリップボードにコピーしました");
      } catch {
        setNotice("コピーしましたが、回収状態を更新できませんでした。もう一度コピーしてください");
      }
    } catch {
      setNotice("コピーできませんでした。文章を選択してコピーしてください");
    } finally { resultActionPendingRef.current = false; setResultActionPending(false); }
  }

  async function resultAction(command: "retry_voice_processing" | "clear_voice_result" | "cancel_voice_processing") {
    if (resultActionPendingRef.current || voiceStateRef.current === "recording") return;
    const generation = resultGenerationRef.current;
    resultActionPendingRef.current = true;
    setResultActionPending(true);
    try {
      if (command === "retry_voice_processing") {
        const saved = await saveConfiguration(undefined, undefined, terms, async () => {
          if (generation !== resultGenerationRef.current) return;
          await appInvoke(command, { generation });
        });
        if (!saved || generation !== resultGenerationRef.current) return;
      } else {
        await appInvoke(command, { generation });
      }
      applyBackgroundVoiceSnapshot(await appInvoke<BackgroundVoiceSnapshot>("background_voice_status"));
      if (command === "clear_voice_result") showRefreshToast("文章を破棄しました");
    } catch (error) {
      setNotice(errorMessage(error, "操作を完了できませんでした。内容はこの画面で確認できます"));
    } finally { resultActionPendingRef.current = false; setResultActionPending(false); }
  }

  function addTerm(event: FormEvent) {
    event.preventDefault();
    if (unreadableDictionary) return;
    const term = termDraft.trim();
    if (!term) { setTermError("言葉を入力してください"); return; }
    if (terms.includes(term)) { setTermError("この言葉は登録済みです"); return; }
    const error = dictionaryError([...terms, term]);
    if (error) { setTermError(error); return; }
    setTerms((current) => [...current, term]);
    setTermDraft("");
    setTermError("");
  }

  const localModel = local?.models.find((model) => model.id === local.selected) ?? local?.models[0];
  const existingDictionaryError = unreadableDictionary ? "保存された辞書を読み取れません。元の保存データは保持しています" : dictionaryError(terms);
  const busy = recording || starting || processing;
  const configurationNotice = configSaving > 0
    ? <p className="configuration-notice" role="status">設定を保存しています</p>
    : configError
      ? <p className="configuration-notice" role="alert"><span>{configError}</span><button className="outline-action" type="button" onClick={() => { if (!unreadableDictionary) void saveConfiguration(undefined, undefined, terms); }} disabled={unreadableDictionary}>設定を再保存</button></p>
      : null;
  const localReady = Boolean(local?.running && localModel?.installed);
  const isMac = navigator.userAgent.includes("Mac");
  const progressFor = (kind: InstallationKind) => installationProgress?.kind === kind ? installationProgress : null;
  const progressPercent = (kind: InstallationKind) => {
    const progress = progressFor(kind);
    return progress?.total ? Math.min(100, Math.floor((progress.completed / progress.total) * 100)) : null;
  };
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
    if (apiKeys?.[id]) return { label: "キー設定済み", className: "state-connected" };
    return { label: "キー未設定", className: "state-unavailable" };
  }
  const codexDisplay = providerDisplayState("codex", outputTarget === "codex");
  const claudeDisplay = providerDisplayState("claude", outputTarget === "claude");
  const geminiDisplay = providerDisplayState("gemini", outputTarget === "gemini");
  const selectedOutput = outputTarget === "codex"
    ? { label: "ChatGPT", detail: "gpt-6-luna", ready: apiKeys?.codex === true }
    : outputTarget === "claude"
      ? { label: "Claude", detail: "Haiku 5.5", ready: apiKeys?.claude === true }
      : outputTarget === "gemini"
        ? { label: "Gemini", detail: "3.6 Flash", ready: apiKeys?.gemini === true }
        : outputTarget === "raw"
          ? { label: "AIなし", detail: "音声認識のみ", ready: Boolean(transcription?.downloaded) }
          : { label: "このPCのAI", detail: localModel?.name || "未準備", ready: localReady };
  function renderGuide() {
    const startKey = <kbd>{shortcutLabel(shortcut, isMac)}</kbd>;
    const questionKey = <kbd>{shortcutLabel(selectionQuestionShortcut, isMac)}</kbd>;
    const features: Array<{ title: string; body: ReactNode }> = [
      { title: "音声入力", body: <>文字を入れたい場所にカーソルを置き、{startKey} を押して話します。もう一度押すと、その場所に文章が入ります。同じ文章はクリップボードにも保存されます。</> },
      { title: "選んだ文章への質問・編集", body: <>文章を選んで {questionKey} を押し、声で質問します。「要約して」「英語にして」「箇条書きにして」のように頼むと、選んだ文章を作り変えます。答えは別の窓に出て、コピーできます。</> },
      { title: "前面の画面への質問", body: <>ホームの「前面の画面を質問・編集」から、いま見ている画面について質問できます。初めて使う時は、OSの画面収録の許可が必要です。</> },
      { title: "Webで調べる", body: <>質問の時に「調べて」「最新の情報で」と頼むと、ChatGPT・Claude・GeminiがWebで検索し、出典のURLを添えて答えます。</> },
      { title: "辞書", body: <>よく使う名前や用語を辞書に登録すると、AIが登録したとおりの書き方で入力します。</> },
      { title: "文章を整えるAI", body: <>AIなし・このPCのAI・ChatGPT・Claude・Geminiから選べます。このPCのAIは「接続と設定」で速さ優先（Gemma 4 E2B）と正確さ優先（Gemma 4 E4B）を切り替えられます。ChatGPT・Claude・Geminiは各社のAPIキーを入れて使い、使った分だけ各社から請求されます。</> },
    ];
    const examples: Array<{ what: string; spoken: string; written: string }> = [
      { what: "順番に挙げた話を番号付きの箇条書きにする", spoken: "えっと明日までにやることが3つあって1つ目が見積書の送付2つ目が請求書のチェック3つ目が会議室の予約です", written: "明日までにやることが3つあります。\n1. 見積書の送付\n2. 請求書のチェック\n3. 会議室の予約" },
      { what: "言い直した時は、後の内容だけを残す", spoken: "今日の会議はあ違う明日の会議はえっと10時からいや10時半からで場所は本社の第2会議室です", written: "明日の会議は10時半からで、場所は本社の第2会議室です。" },
      { what: "「えっと」「あのー」などを除き、句読点を入れる", spoken: "えっとこれ明日までにやっといてもらえるかな", written: "これ明日までにやっといてもらえるかな？" },
      { what: "口調・一人称・語尾はそのまま残す", spoken: "いやーこれまじでやばいね俺はAのデザインのほうがいいと思うわだってBはちょっと地味すぎるし", written: "いやー、これまじでやばいね。俺はAのデザインのほうがいいと思うわ。だってBはちょっと地味すぎるし。" },
      { what: "数字・日付・否定は変えない", spoken: "あのー来週の火曜日の午後3時からの打ち合わせなんですけど資料は持ってこなくていいです参加者は5人です", written: "来週の火曜日の午後3時からの打ち合わせなんですけど、資料は持ってこなくていいです。参加者は5人です。" },
      { what: "よく知られた製品名は正式な書き方にする。質問の形でも答えずに整える", spoken: "えーチャットGPTとクロードとジェミニって何が違うのかあとで教えてもらえますか", written: "ChatGPTとClaudeとGeminiって何が違うのか、あとで教えてもらえますか？" },
      { what: "辞書の言葉は登録したとおりに書く（辞書に「DOON VOICE」を登録した場合）", spoken: "ドゥーンボイスの新しいバージョンを来週みんなに配ります", written: "DOON VOICEの新しいバージョンを、来週みんなに配ります。" },
    ];
    return <section className="simple-view guide-view" aria-labelledby="guide-title">
      <div className="view-heading"><span>HOW TO USE</span><h1 id="guide-title">使い方</h1></div>
      <div className="settings-list"><article><span className="setting-icon"><BrandGlyph name="speed" /></span><div><h2>はじめの設定</h2><p>マイク・音声認識・文章を整えるAI・キーを順番に設定します。</p></div><span /><button className="outline-action" type="button" onClick={openOnboarding}>はじめの設定を開く <ArrowRight size={15} strokeWidth={1.9} /></button></article></div>
      {isMac && <section className="guide-section" aria-labelledby="guide-update-title">
        <div className="section-label"><span>AFTER UPDATE</span><h2 id="guide-update-title">アップデートした後（Mac）</h2></div>
        <p className="guide-lead">Macでは、DOON Voiceをアップデートすると「カーソル位置へ入力」の許可が外れます。そのままでも文章はクリップボードに保存されますが、入力欄へ直接は入りません。次の手順で許可し直してください。</p>
        <ol className="guide-steps">
          <li>ホームか「接続と設定」の「許可する」を押します。前の版の許可は自動で外れ、今のDOON Voiceが一覧に加わります。</li>
          <li>開いた「プライバシーとセキュリティ」→「アクセシビリティ」で、DOON Voiceをオンにします。</li>
          <li>DOON Voiceの画面に戻ると「許可済み」に変わります。</li>
        </ol>
      </section>}
      <section className="guide-section" aria-labelledby="guide-features-title">
        <div className="section-label"><span>FEATURES</span><h2 id="guide-features-title">できること</h2></div>
        <dl className="guide-features">{features.map(({ title, body }) => <div key={title}><dt>{title}</dt><dd>{body}</dd></div>)}</dl>
      </section>
      <section className="guide-section" aria-labelledby="guide-examples-title">
        <div className="section-label"><span>EXAMPLES</span><h2 id="guide-examples-title">AIが整える内容</h2></div>
        <div className="guide-table-wrap"><table className="guide-examples">
          <thead><tr><th scope="col">整え方</th><th scope="col">話した言葉</th><th scope="col">入力される文章</th></tr></thead>
          <tbody>{examples.map(({ what, spoken, written }) => <tr key={what}><th scope="row">{what}</th><td data-label="話した言葉">{spoken}</td><td data-label="入力される文章" className="guide-written">{written}</td></tr>)}</tbody>
        </table></div>
        <p className="guide-note">例は、ChatGPT・Claude・Geminiのような各社のAIで整えた場合です。このPCのAIは小型のため、箇条書きや言い直しの整理が出ないことがあります。AIなしでは、音声認識の結果をそのまま入力します。</p>
      </section>
    </section>;
  }

  function renderOnboarding() {
    const steps = ["マイク", "音声認識", "AI", "キー", "試しに話す", "完了"];
    const micDone = microphoneReady === true;
    const modelDone = Boolean(transcription?.downloaded);
    const cloudTarget = outputTarget === "codex" || outputTarget === "claude" || outputTarget === "gemini";
    const aiDone = outputTarget === "raw" || (outputTarget === "local" && localReady) || (cloudTarget && apiKeys?.[outputTarget] === true);
    const tryDone = Boolean(output);
    const done = [micDone, modelDone, aiDone, true, tryDone, true];
    const last = steps.length - 1;
    const choices: Array<{ id: OutputTarget; label: string; detail: string }> = [
      { id: "raw", label: "AIなし", detail: "話した内容をそのまま文字にします。料金はかかりません" },
      { id: "local", label: "このPCのAI", detail: "PCの中で整えます。料金はかかりません。速さはPCの性能で変わります" },
      { id: "codex", label: "ChatGPT", detail: "OpenAIのAPIキーで整えます。使った分だけOpenAIから請求されます" },
      { id: "claude", label: "Claude", detail: "AnthropicのAPIキーで整えます。使った分だけAnthropicから請求されます" },
      { id: "gemini", label: "Gemini", detail: "GoogleのAPIキーで整えます。使った分だけGoogleから請求されます" },
    ];
    // 手順を移る時は、前の手順の知らせを持ち越さない。
    const next = () => { setNotice(""); setOnboardingStep((current) => Math.min(last, current + 1)); };
    const back = () => { setNotice(""); setOnboardingStep((current) => Math.max(0, current - 1)); };
    const transcriptionProgress = progressFor("transcription");
    const localProgress = progressFor("ollama") || progressFor("local_model");
    const nextButton = (ready: boolean, label = "次へ") => <button className={ready ? "primary-action" : "outline-action"} type="button" onClick={next}>{ready ? label : "あとで設定して次へ"} <ArrowRight size={15} strokeWidth={1.9} /></button>;
    return <section className="simple-view onboarding-view" aria-labelledby="onboarding-title">
      <div className="onboarding-head"><div className="section-label"><span>GETTING STARTED</span><h1 id="onboarding-title">はじめの設定</h1></div><button className="text-action" type="button" onClick={() => navigate("home")}>あとで</button></div>
      <ol className="onboarding-steps" aria-label="設定の手順">{steps.map((label, index) => <li key={label} className={index === onboardingStep ? "is-current" : done[index] && index < onboardingStep ? "is-done" : ""} aria-current={index === onboardingStep ? "step" : undefined}><span className="step-mark" aria-hidden="true">{done[index] && index < onboardingStep ? <Check size={13} strokeWidth={2.4} /> : index + 1}</span><span>{label}</span>{done[index] && index < onboardingStep && <span className="visually-hidden">（完了）</span>}</li>)}</ol>
      <div className="onboarding-body" aria-live="polite">
        {onboardingStep === 0 && <>
          <h2>マイクを使えるようにします</h2>
          <p>ボタンを押すとOSの確認画面が出ます。許可すると、実際に録音できるかも確かめます。</p>
          <p className={micDone ? "onboarding-state is-done" : "onboarding-state"}>{micDone ? <Check size={15} strokeWidth={2.3} /> : <CircleAlert size={15} strokeWidth={2} />}{micDone ? "マイクの接続を確認しました" : microphoneReady === false ? "録音できませんでした。マイクの接続を確かめて、もう一度押してください" : "まだ確認していません"}</p>
          <div className="onboarding-actions"><button className={micDone ? "outline-action" : "primary-action"} type="button" onClick={() => void requestMicrophonePermission()} disabled={checkingMicrophone}>{checkingMicrophone ? "確認中" : micDone ? "もう一度確認" : "マイクを許可・確認"} <Mic size={15} /></button>{nextButton(micDone)}</div>
        </>}
        {onboardingStep === 1 && <>
          <h2>音声認識モデルを取得します</h2>
          <p>話した言葉をこのPCの中で文字にするためのデータです（約574MB）。取得は最初の1回だけです。</p>
          {transcriptionProgress && <div className="installation-progress" role="status"><span>{transcriptionProgress.phase}</span><strong>{installationProgressLabel(transcriptionProgress, installationNow)}</strong><i aria-hidden="true"><b style={{ width: `${progressPercent("transcription") ?? 8}%` }} /></i></div>}
          <p className={modelDone ? "onboarding-state is-done" : "onboarding-state"}>{modelDone ? <Check size={15} strokeWidth={2.3} /> : <Download size={15} strokeWidth={2} />}{modelDone ? "取得済みです" : downloadingTranscription ? "取得しています" : "まだ取得していません"}</p>
          <div className="onboarding-actions">{!modelDone && <button className="primary-action" type="button" onClick={() => void downloadTranscriptionModel()} disabled={downloadingTranscription}>{downloadingTranscription ? "取得中" : "モデルを取得"} <Download size={15} /></button>}<button className="outline-action" type="button" onClick={back}><ArrowLeft size={15} strokeWidth={1.9} /> 戻る</button>{nextButton(modelDone)}</div>
        </>}
        {onboardingStep === 2 && <>
          <h2>文章を整えるAIを選びます</h2>
          <div className="onboarding-choices" role="radiogroup" aria-label="文章を整えるAI">{choices.map(({ id, label, detail }) => <button key={id} type="button" role="radio" aria-checked={outputTarget === id} className={outputTarget === id ? "is-selected" : ""} disabled={busy} onClick={() => chooseOutputTarget(id)}><span><strong>{label}</strong><small>{detail}</small></span>{outputTarget === id && <Check size={16} strokeWidth={2.2} />}</button>)}</div>
          {cloudTarget && (() => { const id = outputTarget as ProviderId; const provider = providers.find((item) => item.id === id)!; const saving = savingKeys[id]; return <div className="onboarding-key">
            {apiKeys?.[id] ? <p className="onboarding-state is-done"><Check size={15} strokeWidth={2.3} />{provider.label}のAPIキーは保存済みです</p> : <form className="api-key-form" onSubmit={(event) => { event.preventDefault(); void saveApiKey(id); }}><input type="password" value={keyDrafts[id]} onChange={(event) => { const value = event.target.value; setKeyDrafts((current) => ({ ...current, [id]: value })); setProviderNotice(id, null); }} placeholder="APIキーを貼り付ける" aria-label={`${provider.label}のAPIキー`} autoComplete="off" spellCheck={false} disabled={saving} /><button className="outline-action" type="submit" disabled={saving || !keyDrafts[id].trim()}>{saving ? "確認中" : "確認して保存"} <KeyRound size={15} strokeWidth={1.9} /></button></form>}
            {providerNotices[id] && <p id={`api-key-notice-${id}`} className={providerNotices[id].error ? "provider-notice is-error" : "provider-notice"} role={providerNotices[id].error ? "alert" : "status"}>{providerNotices[id].text}</p>}
          </div>; })()}
          {outputTarget === "local" && <div className="onboarding-key">
            {localProgress && <div className="installation-progress" role="status"><span>{localProgress.phase}</span><strong>{installationProgressLabel(localProgress, installationNow)}</strong><i aria-hidden="true"><b style={{ width: `${progressPercent("ollama") ?? progressPercent("local_model") ?? 8}%` }} /></i></div>}
            {localReady ? <p className="onboarding-state is-done"><Check size={15} strokeWidth={2.3} />このPCのAIを使えます</p> : !local?.installed ? <button className="outline-action" type="button" onClick={() => void installOllama()} disabled={installingOllama}>{installingOllama ? "準備中" : "このPCのAIを準備"} <Download size={15} /></button> : !local.running ? <button className="outline-action" type="button" onClick={() => void installOllama()} disabled={installingOllama}>{installingOllama ? "起動中" : "このPCのAIを起動"} <Download size={15} /></button> : <button className="outline-action" type="button" onClick={() => void pullModel()} disabled={pullingLocalModel}>{pullingLocalModel ? "取得中" : `${localModel?.name ?? "Gemma"}を取得（${localModel?.size ?? ""}）`} <Download size={15} /></button>}
          </div>}
          <div className="onboarding-actions"><button className="outline-action" type="button" onClick={back}><ArrowLeft size={15} strokeWidth={1.9} /> 戻る</button>{nextButton(aiDone)}</div>
        </>}
        {onboardingStep === 3 && <>
          <h2>キーを決めます</h2>
          <p>ボタンを押してから、使いたい組み合わせを押すと登録されます。このままでよければ次へ進めます。</p>
          <div className="settings-list onboarding-shortcuts">
            <article className="shortcut-row"><div><h3>開始・停止キー</h3><p>{capturingShortcut ? "押した組み合わせを登録します。Escで取り消せます。" : "音声入力の開始と停止"}</p></div><button ref={shortcutButtonRef} className={capturingShortcut ? "shortcut-key is-capturing" : "shortcut-key"} type="button" onClick={() => void beginShortcutCapture()} aria-label="開始・停止キーを変更" aria-pressed={capturingShortcut}>{capturingShortcut ? "キーを押す" : shortcutLabel(shortcut, isMac)}</button><button className="outline-action" type="button" onClick={() => void applyShortcut(DEFAULT_SHORTCUT)}>標準に戻す</button></article>
            <article className="shortcut-row"><div><h3>選択した文章を質問するキー</h3><p>{capturingSelectionQuestionShortcut ? "押した組み合わせを登録します。Escで取り消せます。" : "選んだ文章へ音声で質問"}</p></div><button ref={selectionQuestionShortcutButtonRef} className={capturingSelectionQuestionShortcut ? "shortcut-key is-capturing" : "shortcut-key"} type="button" onClick={() => void beginSelectionQuestionShortcutCapture()} aria-label="選択した文章を質問するキーを変更" aria-pressed={capturingSelectionQuestionShortcut}>{capturingSelectionQuestionShortcut ? "キーを押す" : shortcutLabel(selectionQuestionShortcut, isMac)}</button><button className="outline-action" type="button" onClick={() => void applySelectionQuestionShortcut(DEFAULT_SELECTION_QUESTION_SHORTCUT)}>標準に戻す</button></article>
          </div>
          {notice && <p className="notice" role="alert">{notice}</p>}
          <div className="onboarding-actions"><button className="outline-action" type="button" onClick={back}><ArrowLeft size={15} strokeWidth={1.9} /> 戻る</button>{nextButton(true)}</div>
        </>}
        {onboardingStep === 4 && <>
          <h2>試しに話してみます</h2>
          <p>「話す」を押して話し、もう一度押すと止まります。ふだんは、文字を入れたい場所にカーソルを置いて <kbd>{shortcutLabel(shortcut, isMac)}</kbd> を押すと、同じように入力できます。</p>
          <div className="onboarding-try">
            <button className={recording ? "primary-action is-recording" : "primary-action"} type="button" onClick={() => void toggleRecording()} disabled={starting || processing || !modelDone}>{recording ? "止める" : starting ? "準備中" : processing ? "処理中" : "話す"} <Mic size={15} /></button>
            {!modelDone && <p className="onboarding-state"><CircleAlert size={15} strokeWidth={2} />先に音声認識モデルを取得してください</p>}
            {(processing || output) && <div className="result-output" aria-live="polite">{processing ? "音声を処理しています" : output}</div>}
          </div>
          <div className="onboarding-actions"><button className="outline-action" type="button" onClick={back}><ArrowLeft size={15} strokeWidth={1.9} /> 戻る</button>{nextButton(tryDone)}</div>
        </>}
        {onboardingStep === 5 && <>
          <h2>設定の状態</h2>
          <ul className="onboarding-summary">{[["マイク", micDone], ["音声認識モデル", modelDone], [`文章を整えるAI（${outputTargetLabel(outputTarget)}）`, aiDone]].map(([label, ok]) => <li key={label as string}>{ok ? <Check size={15} strokeWidth={2.3} /> : <CircleAlert size={15} strokeWidth={2} />}<span>{label}</span><strong>{ok ? "設定済み" : "未設定（接続と設定からあとで設定できます）"}</strong></li>)}</ul>
          <p>開始・停止キーは <kbd>{shortcutLabel(shortcut, isMac)}</kbd>、選んだ文章を質問するキーは <kbd>{shortcutLabel(selectionQuestionShortcut, isMac)}</kbd> です。</p>
          <div className="onboarding-actions"><button className="outline-action" type="button" onClick={back}><ArrowLeft size={15} strokeWidth={1.9} /> 戻る</button><button className="primary-action" type="button" onClick={finishOnboarding}>使い始める <ArrowRight size={15} strokeWidth={1.9} /></button></div>
        </>}
      </div>
    </section>;
  }

  const nav = [
    { id: "home" as const, label: "ホーム", glyph: "work" as const },
    { id: "dictionary" as const, label: "辞書", glyph: "coach" as const },
    { id: "guide" as const, label: "使い方", glyph: "speed" as const },
  ];

  return <main className="app-shell">
    <aside className="sidebar" aria-label="DOON Voiceのメニュー">
      <button className="brand" type="button" onClick={() => navigate("home")} aria-label="DOON Voice ホーム"><img src="/brand/doon-logo.png" alt="DOON" /><span>VOICE</span></button>
      <nav className="sidebar-nav">{nav.map(({ id, label, glyph }) => <button className={view === id ? "nav-item is-active" : "nav-item"} key={id} type="button" onClick={() => navigate(id)}><BrandGlyph name={glyph} /> {label}</button>)}</nav>
      <div className="sidebar-bottom"><button className={view === "settings" ? "nav-item is-active" : "nav-item"} type="button" onClick={() => navigate("settings")}><BrandGlyph name="system" /> 接続と設定</button><div className="local-state"><span className={selectedOutput.ready ? "status-dot is-ready" : "status-dot"} /> <span>文章の仕上げ</span><strong>{selectedOutput.label}</strong></div></div>
    </aside>

    <section className="main-canvas">
      <header className="main-bar"><span>{view === "home" ? "DOON VOICE" : view === "dictionary" ? "DICTIONARY" : view === "onboarding" ? "GETTING STARTED" : view === "guide" ? "HOW TO USE" : "SETTINGS"}</span><div className="top-status"><span><i className={selectedOutput.ready ? "status-dot is-ready" : "status-dot"} />{selectedOutput.label}</span><span className="top-status-detail">{selectedOutput.detail}</span>{view !== "onboarding" && view !== "guide" && <button className="icon-button" type="button" onClick={() => navigate("guide")} aria-label="使い方を開く" title="使い方"><CircleHelp size={16} strokeWidth={1.9} /></button>}<button className="icon-button" type="button" onClick={() => void refreshAll(true)} disabled={refreshing} aria-label={refreshing ? "状態を更新中" : "状態を更新"}><RefreshCw className={refreshing ? "is-spinning" : undefined} size={16} strokeWidth={1.9} /></button></div></header>

      {view === "onboarding" && renderOnboarding()}
      {view === "guide" && renderGuide()}
      {view === "home" && <section className="home-view" aria-labelledby="home-title">
        <section className={recording ? "voice-stage is-recording" : "voice-stage"} aria-label="音声入力">
          <div className="hero-brand"><img src="/brand/doon-logo.png" alt="DOON" /><span>VOICE</span></div>
          <h1 id="home-title"><em>AIで</em>言語化をイージーに</h1>
          <p>{recording ? `音声入力中 · ${duration(elapsed)}` : starting ? "マイクを準備しています" : processing ? "音声を処理しています" : "どのアプリにも、そのまま入力。"}</p>
          <button className="record-button" type="button" onClick={() => void toggleRecording()} disabled={starting || processing || (!recording && (configSaving > 0 || Boolean(configError) || Boolean(existingDictionaryError)))} aria-label={recording ? "音声入力を停止" : "音声入力を開始"}><span className="record-button-icon"><Mic size={27} strokeWidth={1.8} /></span><strong>{recording ? "停止" : "話す"}</strong><small>{shortcutLabel(shortcut, isMac)}</small></button>
          <div className="selection-question-actions">
            <button className="selection-question-button" type="button" onClick={() => void openSelectionQuestion()} disabled={busy} aria-label="選択した文章を質問または編集">選択した文章を質問・編集</button>
            <button className="selection-question-button" type="button" onClick={() => void openScreenQuestion()} disabled={busy} aria-label="前面の画面を質問または編集">前面の画面を質問・編集</button>
          </div>
          {(starting || processing) && <button className="outline-action cancel-processing" type="button" onClick={() => void resultAction("cancel_voice_processing")} disabled={resultActionPending} aria-label="処理を取り消す">取り消す</button>}
          {recoveryPending && !busy && <p className="recovery-state">前回の結果はコピーできます。続けて音声入力できます。</p>}
          {isMac && directInputAllowed === false && <p className="recovery-state" role="status">カーソル位置へ入力するには、もう一度許可が必要です <button className="outline-action" type="button" onClick={() => void requestDirectInputPermission()}>許可する</button></p>}
          {existingDictionaryError && <p className="recovery-state" role="alert">辞書に修正が必要です <button className="outline-action" type="button" onClick={() => navigate("dictionary")}>辞書を確認</button></p>}
        </section>
        <section className="destination-section" aria-labelledby="destination-title">
          <div className="section-label"><span>FINISH WITH</span><h2 id="destination-title">文章の仕上げ</h2></div>
          <div className="destination-list">
            <button className={outputTarget === "raw" ? "is-selected" : ""} type="button" disabled={busy} onClick={() => chooseOutputTarget("raw")} aria-pressed={outputTarget === "raw"}><Mic size={27} strokeWidth={1.8} /><span><strong>AIなし</strong><small>{outputTarget === "raw" ? "選択中" : "音声認識のみ"}</small></span>{outputTarget === "raw" && <Check size={16} strokeWidth={2.1} />}</button>
            <button className={outputTarget === "codex" ? "is-selected" : ""} type="button" disabled={busy} onClick={() => chooseOutputTarget("codex")} aria-pressed={outputTarget === "codex"}><BrandGlyph name="spark" /><span><strong>ChatGPT</strong><small className={codexDisplay.className}>{codexDisplay.label}</small></span>{outputTarget === "codex" && <Check size={16} strokeWidth={2.1} />}</button>
            <button className={outputTarget === "claude" ? "is-selected" : ""} type="button" disabled={busy} onClick={() => chooseOutputTarget("claude")} aria-pressed={outputTarget === "claude"}><BrandGlyph name="coach" /><span><strong>Claude</strong><small className={claudeDisplay.className}>{claudeDisplay.label}</small></span>{outputTarget === "claude" && <Check size={16} strokeWidth={2.1} />}</button>
            <button className={outputTarget === "gemini" ? "is-selected" : ""} type="button" disabled={busy} onClick={() => chooseOutputTarget("gemini")} aria-pressed={outputTarget === "gemini"}><BrandGlyph name="loop" /><span><strong>Gemini</strong><small className={geminiDisplay.className}>{geminiDisplay.label}</small></span>{outputTarget === "gemini" && <Check size={16} strokeWidth={2.1} />}</button>
            <button className={outputTarget === "local" ? "is-selected" : ""} type="button" disabled={busy} onClick={() => chooseOutputTarget("local")} aria-pressed={outputTarget === "local"}><BrandGlyph name="dx" /><span><strong>このPCのAI</strong><small className={outputTarget === "local" ? "state-selected" : localReady ? "state-running" : "state-unavailable"}>{outputTarget === "local" ? "選択中" : localReady ? "稼働中" : "未準備"}</small></span>{outputTarget === "local" && <Check size={16} strokeWidth={2.1} />}</button>
          </div>
          {configurationNotice}
        </section>
        {(transcript || output || processing) && <section className="result-section" aria-live="polite" aria-label="音声入力の結果">
          <div className="section-label"><span>RESULT</span><h2>音声入力の結果</h2></div>
          {processing && <p className="result-state">音声を処理しています</p>}
          {transcript && <><h3 className="result-label">原文</h3><p className="transcript">{transcript}</p></>}
          {output && <><h3 className="result-label">{outputTarget === "raw" ? "入力する文章" : "整形結果"}</h3><div className="result-output">{output}</div></>}
          {(transcript || output) && <div className="result-actions">
            {transcript && <button className="outline-action" type="button" disabled={busy || resultActionPending} onClick={() => void copyResult(transcript)}>原文をコピー</button>}
            {output && <button className="outline-action" type="button" disabled={busy || resultActionPending} onClick={() => void copyResult(output)}>文章をコピー</button>}
            {transcript && outputTarget !== "raw" && <button className="outline-action" type="button" disabled={busy || resultActionPending || configSaving > 0 || Boolean(configError) || Boolean(existingDictionaryError)} onClick={() => void resultAction("retry_voice_processing")}>再試行</button>}
            <button className="outline-action" type="button" disabled={busy || resultActionPending} onClick={() => void resultAction("clear_voice_result")}>破棄</button>
            <span>{clipboardSaved ? "クリップボードにコピー済み" : "クリップボードに未保存"}</span>
          </div>}
        </section>}
        {notice && <p className="notice" role="status">{notice}</p>}
      </section>}

      {view === "dictionary" && <section className="simple-view" aria-labelledby="dictionary-title">
        <div className="view-heading"><span>PERSONAL DICTIONARY</span><h1 id="dictionary-title">辞書</h1></div>
        <form className="term-form" onSubmit={addTerm}><input value={termDraft} disabled={unreadableDictionary} onChange={(event) => { setTermDraft(event.target.value); setTermError(""); }} placeholder="言葉を追加" aria-label="辞書に追加する言葉" aria-describedby="dictionary-limits" aria-invalid={Boolean(termError)} /><button type="submit" disabled={unreadableDictionary}><Plus size={16} strokeWidth={2} /> 追加</button></form>
        <p className="dictionary-limits" id="dictionary-limits">{terms.length} / {MAX_DICTIONARY_TERMS}件 · 1件{MAX_TERM_CODEPOINTS}文字まで</p>
        {(termError || existingDictionaryError) && <p className="dictionary-error" role="alert">{termError || existingDictionaryError}</p>}
        {configurationNotice}
        {unreadableDictionary && <button className="outline-action" type="button" onClick={() => { setTerms([]); setUnreadableDictionary(false); }}>読めない辞書を削除</button>}
        {terms.length ? <ul className="term-list">{terms.map((term, index) => {
          const label = typeof term === "string" ? term : JSON.stringify(term);
          return <li key={index}><span>{label || "空の言葉"}</span><button type="button" onClick={() => { setTerms((current) => current.filter((_, itemIndex) => itemIndex !== index)); setTermError(""); }} aria-label={`${label || "無効な項目"}を削除`}><X size={14} strokeWidth={2} /></button></li>;
        })}</ul> : <div className="empty-state"><BrandGlyph name="coach" /><p>登録した言葉はありません</p></div>}
      </section>}

      {view === "settings" && <section className="simple-view settings-view" aria-labelledby="settings-title">
        <div className="view-heading"><span>SETTINGS</span><h1 id="settings-title">接続と設定</h1></div>
        <section className="output-settings" aria-labelledby="output-settings-title">
          <div className="output-settings-heading"><span>TEXT PROCESSOR</span><h2 id="output-settings-title">文章を整えるAI</h2></div>
          <p className="settings-help">おすすめはこのPCのAIです。通信せず、このPC内で文章を整えます。</p>
          <div className="output-choice-list" role="radiogroup" aria-label="文章を整えるAI">
            <button className={outputTarget === "raw" ? "is-selected" : ""} type="button" role="radio" aria-checked={outputTarget === "raw"} disabled={busy} onClick={() => chooseOutputTarget("raw")}><Mic size={27} strokeWidth={1.8} /><span><strong>AIなし</strong><small>音声認識のみ</small></span>{outputTarget === "raw" ? <Check size={17} strokeWidth={2.2} /> : <span>選ぶ</span>}</button>
            <button className={outputTarget === "codex" ? "is-selected" : ""} type="button" role="radio" aria-checked={outputTarget === "codex"} disabled={busy} onClick={() => chooseOutputTarget("codex")}><BrandGlyph name="spark" /><span><strong>ChatGPT</strong><small>OpenAIのAPIで整える</small></span>{outputTarget === "codex" ? <Check size={17} strokeWidth={2.2} /> : <span>選ぶ</span>}</button>
            <button className={outputTarget === "claude" ? "is-selected" : ""} type="button" role="radio" aria-checked={outputTarget === "claude"} disabled={busy} onClick={() => chooseOutputTarget("claude")}><BrandGlyph name="coach" /><span><strong>Claude</strong><small>AnthropicのAPIで整える</small></span>{outputTarget === "claude" ? <Check size={17} strokeWidth={2.2} /> : <span>選ぶ</span>}</button>
            <button className={outputTarget === "gemini" ? "is-selected" : ""} type="button" role="radio" aria-checked={outputTarget === "gemini"} disabled={busy} onClick={() => chooseOutputTarget("gemini")}><BrandGlyph name="loop" /><span><strong>Gemini</strong><small>GoogleのAPIで整える</small></span>{outputTarget === "gemini" ? <Check size={17} strokeWidth={2.2} /> : <span>選ぶ</span>}</button>
            <button className={outputTarget === "local" ? "is-selected" : ""} type="button" role="radio" aria-checked={outputTarget === "local"} disabled={busy} onClick={() => chooseOutputTarget("local")}><BrandGlyph name="dx" /><span><strong>このPCのAI</strong><small>おすすめ · {localModel?.name ?? "Gemma 4"}で整える</small></span>{outputTarget === "local" ? <Check size={17} strokeWidth={2.2} /> : <span>選ぶ</span>}</button>
          </div>
          {configurationNotice}
        </section>
        <section className="output-settings" aria-labelledby="selection-question-settings-title">
          <div className="output-settings-heading"><span>SELECTION ASSIST</span><h2 id="selection-question-settings-title">選択文・画面を質問・編集するAI</h2></div>
          <p className="settings-help">おすすめはChatGPT、Claude、Geminiです。質問、要約、翻訳、文体調整にはクラウドAIを選びます。</p>
          <div className="output-choice-list" role="radiogroup" aria-label="選択文・画面を質問・編集するAI">
            <button className={selectionQuestionTarget === "codex" ? "is-selected" : ""} type="button" role="radio" aria-checked={selectionQuestionTarget === "codex"} disabled={busy} onClick={() => chooseSelectionQuestionTarget("codex")}><BrandGlyph name="spark" /><span><strong>ChatGPT</strong><small>クラウドAIで調べて答える</small></span>{selectionQuestionTarget === "codex" ? <Check size={17} strokeWidth={2.2} /> : <span>選ぶ</span>}</button>
            <button className={selectionQuestionTarget === "claude" ? "is-selected" : ""} type="button" role="radio" aria-checked={selectionQuestionTarget === "claude"} disabled={busy} onClick={() => chooseSelectionQuestionTarget("claude")}><BrandGlyph name="coach" /><span><strong>Claude</strong><small>AnthropicのAPIで答える</small></span>{selectionQuestionTarget === "claude" ? <Check size={17} strokeWidth={2.2} /> : <span>選ぶ</span>}</button>
            <button className={selectionQuestionTarget === "gemini" ? "is-selected" : ""} type="button" role="radio" aria-checked={selectionQuestionTarget === "gemini"} disabled={busy} onClick={() => chooseSelectionQuestionTarget("gemini")}><BrandGlyph name="loop" /><span><strong>Gemini</strong><small>GoogleのAPIで答える</small></span>{selectionQuestionTarget === "gemini" ? <Check size={17} strokeWidth={2.2} /> : <span>選ぶ</span>}</button>
            <button className={selectionQuestionTarget === "local" ? "is-selected" : ""} type="button" role="radio" aria-checked={selectionQuestionTarget === "local"} disabled={busy} onClick={() => chooseSelectionQuestionTarget("local")}><BrandGlyph name="dx" /><span><strong>このPCのAI</strong><small>{localModel?.name ?? "Gemma 4"}で答える</small></span>{selectionQuestionTarget === "local" ? <Check size={17} strokeWidth={2.2} /> : <span>選ぶ</span>}</button>
          </div>
        </section>
        <div className="settings-list"><article><span className="setting-icon"><BrandGlyph name="speed" /></span><div><h2>はじめの設定</h2><p>マイク・音声認識・文章を整えるAIを順番に設定します。</p></div><span /><button className="outline-action" type="button" onClick={openOnboarding}>案内を開く <ArrowRight size={15} strokeWidth={1.9} /></button></article></div>
        <div className="settings-list"><article className="app-update-row"><span className="setting-icon"><RefreshCw size={22} strokeWidth={1.8} /></span><div><h2>アプリの更新</h2><p>現在の版: {appVersion === null ? "確認中" : appVersion === "開発版" || appVersion === "確認できません" ? appVersion : `v${appVersion}`}</p><p>{updateCheckError ? `確認エラー: ${updateCheckError}` : updateCheckedAt === null ? "最新版はまだ確認していません。" : latestAppVersion && latestAppVersion !== appVersion ? `確認した最新版: v${latestAppVersion}` : `確認結果: 現在の版が最新版です（${new Date(updateCheckedAt).toLocaleString("ja-JP")}）`}</p></div><span className={latestAppVersion && latestAppVersion !== appVersion ? "setting-state state-available" : "setting-state state-permitted"}>{latestAppVersion && latestAppVersion !== appVersion ? <Download size={15} strokeWidth={2} /> : <Check size={15} strokeWidth={2.3} />}{latestAppVersion && latestAppVersion !== appVersion ? `v${latestAppVersion}あり` : "自動更新対応"}</span><button className="outline-action" type="button" onClick={() => void updateApp()} disabled={updatingApp || busy}>{updatingApp ? "更新中" : "更新を確認"} <RefreshCw className={updatingApp ? "is-spinning" : undefined} size={15} /></button></article></div>
        <div className="settings-list direct-input-settings"><article><span className="setting-icon"><BrandGlyph name="move" /></span><div><h2>カーソル位置へ入力</h2><p>{directInputAllowed ? "ほかのアプリへ直接入力できます。" : "macOSのアクセシビリティ許可が必要です。アップデートの後も、「許可する」を押して一覧のDOON Voiceをオンにすれば使えます。"}</p></div><span className={directInputAllowed ? "setting-state state-permitted" : "setting-state state-unavailable"}>{directInputAllowed ? <Check size={15} strokeWidth={2.3} /> : <CircleAlert size={15} strokeWidth={2} />}{directInputAllowed ? "許可済み" : "未許可"}</span>{isMac ? <button className="outline-action" type="button" onClick={() => void (directInputAllowed ? openDirectInputSettings() : requestDirectInputPermission())}>{directInputAllowed ? "設定を開く" : "許可する"} <ExternalLink size={15} /></button> : <span />}</article></div>
        <div className="settings-list microphone-settings"><article><span className="setting-icon"><Mic size={22} strokeWidth={1.8} /></span><div><h2>マイク</h2><p>{microphoneReady === true ? "許可と実際のマイク接続を確認しました。" : microphoneReady === false ? "許可だけでは録音できない場合があります。マイク接続を確認して、もう一度試してください。" : microphonePermissionState === "granted" ? "許可済みです。実際に録音できるか確認してください。" : microphonePermissionState === "unsupported" ? "この環境ではマイクを使えません。" : "初回にこのボタンからマイクを許可・確認します。"}</p></div><span className={microphoneReady === true ? "setting-state state-permitted" : "setting-state state-unavailable"}>{microphoneReady === true ? <Check size={15} strokeWidth={2.3} /> : <CircleAlert size={15} strokeWidth={2} />}{microphoneReady === true ? "接続確認済み" : microphonePermissionState === "unsupported" ? "利用不可" : microphonePermissionState === "granted" ? "確認が必要" : "許可が必要"}</span><button className="outline-action" type="button" onClick={() => void requestMicrophonePermission()} disabled={checkingMicrophone || microphonePermissionState === "unsupported"}>{checkingMicrophone ? "確認中" : microphoneReady === true ? "もう一度確認" : "マイクを許可・確認"} <Mic size={15} /></button></article></div>
        <div className="settings-list transcription-settings"><article><span className="setting-icon"><BrandGlyph name="work" /></span><div><h2>音声認識</h2><p>{transcription?.downloaded ? "日本語音声認識をこのPCで行います。" : "話した言葉を文字にする日本語モデルです。"}</p>{progressFor("transcription") && <div className="installation-progress" role="status"><span>{progressFor("transcription")?.phase}</span><strong>{installationProgressLabel(progressFor("transcription")!, installationNow)}</strong><i aria-hidden="true"><b style={{ width: `${progressPercent("transcription") ?? 8}%` }} /></i></div>}</div><span className={transcription?.downloaded ? "setting-state state-installed" : "setting-state state-unavailable"}>{transcription?.downloaded ? <Check size={15} strokeWidth={2.3} /> : <Download size={15} strokeWidth={2} />}{transcription?.downloaded ? "モデル取得済み" : downloadingTranscription ? `${progressPercent("transcription") ?? "…"}%` : transcription?.size || "未取得"}</span>{transcription?.downloaded ? <span /> : <button className="outline-action" type="button" onClick={() => void downloadTranscriptionModel()} disabled={downloadingTranscription}>{downloadingTranscription ? "取得中" : "モデルを取得"} <Download size={15} /></button>}</article></div>
        <div className="settings-list">{providers.map(({ id, label, detail, glyph }) => { const status = providerDisplayState(id, false); const saving = savingKeys[id]; const hasKey = apiKeys?.[id] === true; return <article key={id} className="api-key-row"><span className="setting-icon"><BrandGlyph name={glyph} /></span><div><h2>{label}</h2><p>{detail}</p><form className="api-key-form" onSubmit={(event) => { event.preventDefault(); void saveApiKey(id); }}><input type="password" value={keyDrafts[id]} onChange={(event) => { const value = event.target.value; setKeyDrafts((current) => ({ ...current, [id]: value })); setProviderNotice(id, null); }} placeholder={hasKey ? "新しいキーに置き換える" : "APIキーを貼り付ける"} aria-label={`${label}のAPIキー`} autoComplete="off" spellCheck={false} disabled={saving} /><button className="outline-action" type="submit" disabled={saving || !keyDrafts[id].trim()}>{saving ? "確認中" : "確認して保存"} <KeyRound size={15} strokeWidth={1.9} /></button></form>{providerNotices[id] && <p id={`api-key-notice-${id}`} className={providerNotices[id].error ? "provider-notice is-error" : "provider-notice"} role={providerNotices[id].error ? "alert" : "status"}>{providerNotices[id].text}</p>}</div><span className={`setting-state ${status.className}`}>{saving ? <span className="state-connecting-mark" aria-hidden="true" /> : hasKey ? <Check size={15} strokeWidth={2.3} /> : <CircleAlert size={15} strokeWidth={2} />}{status.label}</span>{hasKey ? <button className="outline-action" type="button" onClick={() => void deleteApiKey(id)} onBlur={() => setConfirmingKeyDelete((current) => current === id ? null : current)} disabled={saving}>{confirmingKeyDelete === id ? "もう一度押すと削除" : "キーを削除"} <Trash2 size={15} strokeWidth={1.9} /></button> : <span />}</article>; })}<article><span className="setting-icon"><BrandGlyph name="dx" /></span><div><h2>ローカルAI</h2><p>{localReady ? `${localModel?.name}がこのPCで稼働中です。` : `${localModel?.name ?? "Gemma"}をDOON Voice用に取得します。Ollamaアカウントは不要です。`}</p>{local && local.models.length > 1 && <div className="local-model-choices" role="radiogroup" aria-label="このPCのAIのモデル">{local.models.map((model) => <button key={model.id} type="button" role="radio" aria-checked={local.selected === model.id} className={local.selected === model.id ? "is-selected" : ""} disabled={busy || pullingLocalModel} onClick={() => void chooseLocalModel(model.id)}><strong>{model.id === "fast" ? "速さ優先" : "正確さ優先"}</strong><small>{model.name}・{model.size}{model.installed ? "・取得済み" : ""}</small><small className="local-model-merit">良い点：{model.id === "fast" ? "容量とメモリーが少なく、性能の低いPCでも動かしやすい" : "聞き間違えた漢字の直しや整え方がより正確"}</small><small className="local-model-demerit">気になる点：{model.id === "fast" ? "漢字の聞き間違いや「？」の付け忘れが残りやすい" : "容量とメモリーを多く使い、性能の低いPCでは時間がかかることがある"}</small></button>)}</div>}{(progressFor("ollama") || progressFor("local_model")) && <div className="installation-progress" role="status"><span>{(progressFor("ollama") || progressFor("local_model"))?.phase}</span><strong>{installationProgressLabel((progressFor("ollama") || progressFor("local_model"))!, installationNow)}</strong><i aria-hidden="true"><b style={{ width: `${progressPercent("ollama") ?? progressPercent("local_model") ?? 8}%` }} /></i></div>}</div><span className={localReady ? "setting-state state-running" : "setting-state state-unavailable"}>{localReady ? <span className="state-live-dot" aria-hidden="true" /> : <WifiOff size={15} strokeWidth={2} />}{localReady ? "稼働中" : installingOllama || pullingLocalModel ? `${progressPercent("ollama") ?? progressPercent("local_model") ?? "…"}%` : local?.installed ? "起動待ち" : "未準備"}</span>{!local?.installed ? <button className="outline-action" type="button" onClick={() => void installOllama()} disabled={installingOllama}>{installingOllama ? "ローカルAIを準備中" : "サインアップ不要でローカルAIを準備"} <Download size={15} /></button> : !local.running ? <button className="outline-action" type="button" onClick={() => void installOllama()} disabled={installingOllama}>{installingOllama ? "ローカルAIを起動中" : "ローカルAIを起動"} <Download size={15} /></button> : !localModel?.installed ? <button className="outline-action" type="button" onClick={() => void pullModel()} disabled={pullingLocalModel}>{pullingLocalModel ? "取得中" : `${localModel?.name ?? "Gemma"}を取得`} <Download size={15} /></button> : <span />}</article><article className="shortcut-row"><span className="setting-icon"><BrandGlyph name="speed" /></span><div><h2>開始・停止キー</h2><p>{capturingShortcut ? "押した組み合わせを登録します。Escで取り消せます。" : "通常の音声入力の開始と停止"}</p></div><button ref={shortcutButtonRef} className={capturingShortcut ? "shortcut-key is-capturing" : "shortcut-key"} type="button" onClick={() => void beginShortcutCapture()} aria-label="開始・停止キーを変更" aria-pressed={capturingShortcut}>{capturingShortcut ? "キーを押す" : shortcutLabel(shortcut, navigator.userAgent.includes("Mac"))}</button><button className="outline-action" type="button" onClick={() => void applyShortcut(DEFAULT_SHORTCUT)}>標準に戻す</button></article><article className="shortcut-row"><span className="setting-icon"><BrandGlyph name="speed" /></span><div><h2>選択した文章を質問するキー</h2><p>{capturingSelectionQuestionShortcut ? "押した組み合わせを登録します。Escで取り消せます。" : "選択中の文章へ音声で質問"}</p></div><button ref={selectionQuestionShortcutButtonRef} className={capturingSelectionQuestionShortcut ? "shortcut-key is-capturing" : "shortcut-key"} type="button" onClick={() => void beginSelectionQuestionShortcutCapture()} aria-label="選択した文章を質問するキーを変更" aria-pressed={capturingSelectionQuestionShortcut}>{capturingSelectionQuestionShortcut ? "キーを押す" : shortcutLabel(selectionQuestionShortcut, navigator.userAgent.includes("Mac"))}</button><button className="outline-action" type="button" onClick={() => void applySelectionQuestionShortcut(DEFAULT_SELECTION_QUESTION_SHORTCUT)}>標準に戻す</button></article></div>{notice && <p className="notice" role="status">{notice}</p>}</section>}
    </section>

    {refreshToast && <div className="refresh-toast" role="status"><Check size={16} strokeWidth={2.2} />{refreshToast}</div>}

    {questionOpen && <div className="question-backdrop" role="presentation">
      <section className="question-dialog" role="dialog" aria-modal="true" aria-labelledby="selection-question-title">
        <header className="question-dialog-header"><div><span>ASK WITH SELECTION</span><h2 id="selection-question-title">選択した文章を質問</h2></div><button className="icon-button" type="button" onClick={closeSelectionQuestion} aria-label="質問を閉じる"><X size={19} strokeWidth={2} /></button></header>
        <p className="question-selection" aria-label="選択した文章">{questionSelection}</p>
        {questionAnswer && <section className="question-answer" aria-live="polite"><span>ANSWER</span><div>{questionAnswer}</div></section>}
        {questionPhase === "answering" && <p className="question-progress" role="status">回答を考えています</p>}
        {questionPhase === "transcribing" && <p className="question-progress" role="status">質問を文字にしています</p>}
        {questionError && <p className="question-error" role="alert">{questionError}</p>}
        <div className="question-compose">
          <textarea ref={questionInputRef} value={questionDraft} disabled={questionPhase === "recording" || questionPhase === "transcribing" || questionPhase === "answering"} onChange={(event) => setQuestionDraft(event.target.value)} onCompositionStart={() => { questionComposingRef.current = true; }} onCompositionEnd={() => { questionComposingRef.current = false; }} onKeyDown={questionKeyDown} placeholder="質問を入力" aria-label="選択した文章への質問" />
          <div className="question-compose-actions"><button className={questionPhase === "recording" ? "outline-action is-recording" : "outline-action"} type="button" onClick={() => void toggleQuestionVoice()} disabled={questionPhase === "starting" || questionPhase === "transcribing" || questionPhase === "answering"}>{questionPhase === "recording" ? "録音を止める" : "音声で質問"}</button><button className="outline-action question-send" type="button" onClick={() => void askSelectionQuestion()} disabled={!questionDraft.trim() || questionPhase === "starting" || questionPhase === "recording" || questionPhase === "transcribing" || questionPhase === "answering"}>実行する</button></div>
        </div>
        {questionAnswer && <div className="question-answer-actions"><button className="outline-action" type="button" onClick={() => void copyQuestionAnswer()}>回答をコピー</button><button className="outline-action question-send" type="button" onClick={() => void pasteQuestionAnswer()}>カーソル位置へ入力</button></div>}
      </section>
    </div>}

  </main>;
}

function VoiceOverlay() {
  const initial = new URLSearchParams(window.location.search).get("overlay");
  const [state] = useState<OverlayState>(
    initial === "starting" || initial === "thinking" || initial === "done" || initial === "error" ? initial : "listening",
  );
  const [failureDetail, setFailureDetail] = useState("");
  useEffect(() => {
    document.documentElement.classList.add("is-overlay");
    if (!isTauriApp()) {
      return () => document.documentElement.classList.remove("is-overlay");
    }
    void appInvoke<string>("voice_overlay_status")
      .then((detail) => {
        if (detail) setFailureDetail(detail);
      })
      .catch(() => undefined);
    return () => {
      document.documentElement.classList.remove("is-overlay");
    };
  }, []);
  const label = state === "starting" ? "準備しています" : state === "listening" ? "聞いています" : state === "thinking" ? "処理しています" : state === "done" ? "入力しました" : "入力できませんでした";
  const detail = state === "starting" ? "マイクを準備しています" : state === "listening" ? "音声を受け取っています" : state === "thinking" ? "音声を処理しています" : state === "done" ? "カーソル位置へ入力しました" : failureDetail || "DOON Voiceで内容を確認してください";
  return <main className={`voice-overlay is-${state}`} aria-live="assertive">
    <span className="voice-overlay-icon"><Mic size={25} strokeWidth={1.9} /></span>
    <span className="voice-overlay-copy"><small>DOON VOICE</small><strong>{label}</strong><em>{detail}</em></span>
    {state === "listening" ? <span className="voice-bars" aria-hidden="true"><i /><i /><i /><i /><i /></span> : state === "starting" || state === "thinking" ? <span className="overlay-spinner" aria-hidden="true" /> : state === "error" ? <X size={21} strokeWidth={2.2} /> : <Check size={21} strokeWidth={2.2} />}
  </main>;
}

function SelectionQuestionPopup() {
  const [payload, setPayload] = useState<SelectionQuestionPopupPayload | null>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");
  const [answering, setAnswering] = useState(false);
  const [notice, setNotice] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const composingRef = useRef(false);

  useEffect(() => {
    void appInvoke<SelectionQuestionPopupPayload>("selection_question_popup_payload")
      .then((next) => {
        setPayload(next);
        setQuestion(next.question);
        setAnswer(next.answer || "");
        setError(next.error || "");
        window.setTimeout(() => inputRef.current?.focus(), 0);
      })
      .catch((reason) => setError(errorMessage(reason, "回答の内容を読み取れませんでした")));
  }, []);

  async function ask() {
    if (!payload || answering || !question.trim()) return;
    setAnswering(true);
    setError("");
    try {
      const next = await appInvoke<string>("answer_open_question", {
        target: payload.target,
        question: question.trim(),
      });
      setAnswer(next);
    } catch (reason) {
      setError(errorMessage(reason, "回答を作れませんでした"));
    } finally {
      setAnswering(false);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }

  async function copyAnswer() {
    if (!answer) return;
    try {
      await navigator.clipboard.writeText(answer);
      setNotice("回答をクリップボードにコピーしました");
      window.setTimeout(() => setNotice(""), 3500);
    } catch {
      setError("回答をコピーできませんでした。文章を選択してコピーしてください");
    }
  }

  function onQuestionKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    void ask();
  }

  return <main className="selection-question-popup-shell">
    <section className="selection-question-popup" role="dialog" aria-modal="false" aria-labelledby="selection-question-popup-title">
      <header className="question-dialog-header"><div><span>{payload?.context_kind === "screen" ? "ASK WITH SCREEN" : "ASK WITH SELECTION"}</span><h2 id="selection-question-popup-title">{payload?.context_kind === "screen" ? "前面の画面を質問" : "選択した文章を質問・編集"}</h2></div><button className="icon-button" type="button" onClick={() => void appInvoke("close_selection_question_popup")} aria-label="質問を閉じる"><X size={19} strokeWidth={2} /></button></header>
      {!payload && !error && <p className="question-progress" role="status">回答を準備しています</p>}
      {payload && <><p className="question-selection" aria-label={payload.context_kind === "screen" ? "読み取った画面" : "選択した文章"}>{payload.selection}</p>
        {answer && <section className="question-answer" aria-live="polite"><span>ANSWER</span><div>{answer}</div></section>}
        {error && <p className="question-error" role="alert">{error}</p>}
        <div className="question-compose"><textarea ref={inputRef} value={question} disabled={answering} onChange={(event) => setQuestion(event.target.value)} onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }} onKeyDown={onQuestionKeyDown} placeholder="質問または編集指示を入力" aria-label={payload.context_kind === "screen" ? "画面への質問" : "選択した文章への質問または編集指示"} /><div className="question-compose-actions"><button className="outline-action question-send" type="button" onClick={() => void ask()} disabled={!question.trim() || answering}>{answering ? "処理中" : "実行する"}</button></div></div>
        {answer && <div className="question-answer-actions"><button className="outline-action" type="button" onClick={() => void copyAnswer()}>回答をコピー</button></div>}
      </>}
      {notice && <p className="notice" role="status">{notice}</p>}
    </section>
  </main>;
}

export default function App() {
  const query = new URLSearchParams(window.location.search);
  if (query.has("overlay")) return <VoiceOverlay />;
  if (query.has("selection-question-popup")) return <SelectionQuestionPopup />;
  return <MainApp />;
}
