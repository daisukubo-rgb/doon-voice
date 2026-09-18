import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Check, CircleAlert, Download, ExternalLink, Mic, Plus, RefreshCw, WifiOff, X } from "lucide-react";
import { FormEvent, KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from "react";
import { AudioRecorder, requestMicrophoneAccess, startAudioRecorder } from "./audio-recorder";
import { DEFAULT_OUTPUT_TARGET, DEFAULT_SELECTION_QUESTION_TARGET, isOutputTarget, isSelectionQuestionTarget, OutputTarget, outputTargetLabel, SelectionQuestionTarget } from "./output-target";
import { DEFAULT_SELECTION_QUESTION_SHORTCUT, DEFAULT_SHORTCUT, shortcutCaptureResult, shortcutLabel } from "./shortcut";

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
type QuestionPhase = "ready" | "recording" | "transcribing" | "answering" | "answer";
type SelectionQuestionEvent = { selection: string; question: string; answer: string };
type SelectionQuestionErrorEvent = { selection: string; question: string; error: string };
type SelectionQuestionPopupPayload = { selection: string; question: string; answer?: string; error?: string; target: OutputTarget };

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

function savedProviderConnections(key = "doon-voice-provider-connections"): ProviderConnections {
  try {
    const saved = JSON.parse(window.localStorage.getItem(key) || "null");
    if (saved && typeof saved === "object") {
      return { codex: saved.codex === true, claude: saved.claude === true, gemini: saved.gemini === true };
    }
  } catch { /* 明示的な接続の記録がない場合は接続済みと推測しない */ }
  return { codex: false, claude: false, gemini: false };
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
  const [view, setView] = useState<View>("home");
  const [statuses, setStatuses] = useState<Record<ProviderId, ProviderStatus | null>>({ codex: null, claude: null, gemini: null });
  const [connectedProviders, setConnectedProviders] = useState<ProviderConnections>(() => savedProviderConnections());
  const pendingConnectionsRef = useRef(savedProviderConnections("doon-voice-pending-connections"));
  const [local, setLocal] = useState<LocalLlmStatus | null>(null);
  const [installingOllama, setInstallingOllama] = useState(false);
  const [pullingLocalModel, setPullingLocalModel] = useState(false);
  const [downloadingTranscription, setDownloadingTranscription] = useState(false);
  const [installationProgress, setInstallationProgress] = useState<InstallationProgress | null>(null);
  const [installationNow, setInstallationNow] = useState(() => Date.now());
  const [microphonePermissionState, setMicrophonePermissionState] = useState<MicrophonePermission>("unknown");
  const [notice, setNotice] = useState("");
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
  const [connectingProviders, setConnectingProviders] = useState<Record<ProviderId, boolean>>({ codex: false, claude: false, gemini: false });
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

  useEffect(() => { void refreshAll(); }, []);
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

  function focusQuestionInput() {
    window.setTimeout(() => questionInputRef.current?.focus(), 0);
  }

  async function openSelectionQuestion() {
    if (busy || questionPhase === "recording" || questionPhase === "transcribing" || questionPhase === "answering") return;
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
      if (operation === questionOperationRef.current) setNotice(errorMessage(error, "選択した文章を読み取れませんでした"));
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
    if (!normalizedQuestion || questionPhase === "recording" || questionPhase === "transcribing" || questionPhase === "answering") return;
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
    if (questionPhase === "answering" || questionPhase === "transcribing") return;
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
    try {
      setQuestionError("");
      questionRecorderRef.current = await startAudioRecorder();
      setQuestionPhase("recording");
    } catch (error) {
      setQuestionError(errorMessage(error, "質問用のマイクを開始できませんでした"));
    }
  }

  async function copyQuestionAnswer() {
    if (!questionAnswer) return;
    try {
      await navigator.clipboard.writeText(questionAnswer);
      setQuestionError("");
      setNotice("回答をクリップボードにコピーしました");
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
      if (notify) setNotice(`開始・停止キーを ${shortcutLabel(next, navigator.userAgent.includes("Mac"))} に変更しました`);
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
      if (notify) setNotice(`選択文を質問するキーを ${shortcutLabel(next, navigator.userAgent.includes("Mac"))} に変更しました`);
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

  function navigate(next: View) { cancelShortcutCapture(); setView(next); }

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
      if (result.kind === "invalid") { setNotice("Control、Option/Alt、Shift、Commandのいずれかを一緒に押してください"); return; }
      if (captureInput) void applyShortcut(result.shortcut);
      else void applySelectionQuestionShortcut(result.shortcut);
    };
    window.addEventListener("keydown", captureShortcut, true);
    return () => window.removeEventListener("keydown", captureShortcut, true);
  }, [capturingShortcut, capturingSelectionQuestionShortcut]);

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
    if (voiceStateRef.current !== "idle") {
      setNotice("音声入力が終わってからAIを変更してください");
      return;
    }
    if (unreadableDictionary) { setConfigError("保存された辞書を読み取れません。辞書画面で確認してください"); return; }
    void saveConfiguration(target, undefined, terms).then((saved) => {
      if (saved) setNotice(target === "raw" ? "AIなしの音声入力に変更しました" : `文章を整えるAIを ${outputTargetLabel(target)} に変更しました`);
    });
  }

  function chooseSelectionQuestionTarget(target: SelectionQuestionTarget) {
    if (voiceStateRef.current !== "idle") {
      setNotice("音声入力が終わってからAIを変更してください");
      return;
    }
    if (unreadableDictionary) { setConfigError("保存された辞書を読み取れません。辞書画面で確認してください"); return; }
    void saveConfiguration(undefined, target, terms).then((saved) => {
      if (saved) setNotice(`選択文を質問するAIを ${outputTargetLabel(target)} に変更しました`);
    });
  }

  async function installOllama() {
    if (installingOllama) return;
    setInstallingOllama(true);
    setInstallationProgress({ kind: "ollama", phase: "ダウンロードを準備しています", completed: 0, total: 0, startedAt: Date.now() });
    setNotice("Ollamaのインストーラーを取得しています。完了までこの画面を開いたままにしてください");
    try {
      await appInvoke("open_local_llm_install");
      setNotice("Ollamaのインストーラーを起動しました。完了後に更新するとGemmaを取得できます");
      window.setTimeout(() => { void refreshAll(); }, 3000);
    } catch (error) {
      setNotice(errorMessage(error, "Ollamaのインストーラーを取得できませんでした。公式サイトから手動で入れてください"));
    } finally {
      setInstallingOllama(false);
      setInstallationProgress(null);
    }
  }

  async function requestMicrophonePermission() {
    try {
      await requestMicrophoneAccess();
      setMicrophonePermissionState("granted");
      setNotice("マイクを許可しました");
    } catch (error) {
      const status = await microphonePermission();
      setMicrophonePermissionState(status);
      setNotice(errorMessage(error, "マイクを許可できませんでした。OSのマイク設定を確認してください"));
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
    setInstallationProgress({ kind: "local_model", phase: "モデルの取得を準備しています", completed: 0, total: 0, startedAt: Date.now() });
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
      setInstallationProgress(null);
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
      setNotice("日本語音声認識モデルを準備しました");
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
        setNotice("クリップボードにコピーしました");
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
      if (command === "clear_voice_result") setNotice("文章を破棄しました");
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

  const localModel = local?.models[0];
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
          <button className="record-button" type="button" onClick={() => void toggleRecording()} disabled={starting || processing || (!recording && (configSaving > 0 || Boolean(configError) || Boolean(existingDictionaryError)))} aria-label={recording ? "音声入力を停止" : "音声入力を開始"}><span className="record-button-icon"><Mic size={27} strokeWidth={1.8} /></span><strong>{recording ? "停止" : "話す"}</strong><small>{shortcutLabel(shortcut, isMac)}</small></button>
          <button className="selection-question-button" type="button" onClick={() => void openSelectionQuestion()} disabled={busy} aria-label="選択した文章を質問">選択した文章を質問</button>
          {(starting || processing) && <button className="outline-action cancel-processing" type="button" onClick={() => void resultAction("cancel_voice_processing")} disabled={resultActionPending} aria-label="処理を取り消す">取り消す</button>}
          {recoveryPending && !busy && <p className="recovery-state">前回の結果はコピーできます。続けて音声入力できます。</p>}
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
            <button className={outputTarget === "codex" ? "is-selected" : ""} type="button" role="radio" aria-checked={outputTarget === "codex"} disabled={busy} onClick={() => chooseOutputTarget("codex")}><BrandGlyph name="spark" /><span><strong>ChatGPT</strong><small>Codexで整える</small></span>{outputTarget === "codex" ? <Check size={17} strokeWidth={2.2} /> : <span>選ぶ</span>}</button>
            <button className={outputTarget === "claude" ? "is-selected" : ""} type="button" role="radio" aria-checked={outputTarget === "claude"} disabled={busy} onClick={() => chooseOutputTarget("claude")}><BrandGlyph name="coach" /><span><strong>Claude</strong><small>Claude Codeで整える</small></span>{outputTarget === "claude" ? <Check size={17} strokeWidth={2.2} /> : <span>選ぶ</span>}</button>
            <button className={outputTarget === "gemini" ? "is-selected" : ""} type="button" role="radio" aria-checked={outputTarget === "gemini"} disabled={busy} onClick={() => chooseOutputTarget("gemini")}><BrandGlyph name="loop" /><span><strong>Gemini</strong><small>Antigravity Flashで整える</small></span>{outputTarget === "gemini" ? <Check size={17} strokeWidth={2.2} /> : <span>選ぶ</span>}</button>
            <button className={outputTarget === "local" ? "is-selected" : ""} type="button" role="radio" aria-checked={outputTarget === "local"} disabled={busy} onClick={() => chooseOutputTarget("local")}><BrandGlyph name="dx" /><span><strong>このPCのAI</strong><small>おすすめ · Gemma 4 E2Bで整える</small></span>{outputTarget === "local" ? <Check size={17} strokeWidth={2.2} /> : <span>選ぶ</span>}</button>
          </div>
          {configurationNotice}
        </section>
        <section className="output-settings" aria-labelledby="selection-question-settings-title">
          <div className="output-settings-heading"><span>SELECTION QUESTION</span><h2 id="selection-question-settings-title">選択文を質問するAI</h2></div>
          <p className="settings-help">おすすめはChatGPTです。調査や最新情報の確認には、クラウドAIを選びます。</p>
          <div className="output-choice-list" role="radiogroup" aria-label="選択文を質問するAI">
            <button className={selectionQuestionTarget === "codex" ? "is-selected" : ""} type="button" role="radio" aria-checked={selectionQuestionTarget === "codex"} disabled={busy} onClick={() => chooseSelectionQuestionTarget("codex")}><BrandGlyph name="spark" /><span><strong>ChatGPT</strong><small>おすすめ · 調べて答える</small></span>{selectionQuestionTarget === "codex" ? <Check size={17} strokeWidth={2.2} /> : <span>選ぶ</span>}</button>
            <button className={selectionQuestionTarget === "claude" ? "is-selected" : ""} type="button" role="radio" aria-checked={selectionQuestionTarget === "claude"} disabled={busy} onClick={() => chooseSelectionQuestionTarget("claude")}><BrandGlyph name="coach" /><span><strong>Claude</strong><small>Claude Codeで答える</small></span>{selectionQuestionTarget === "claude" ? <Check size={17} strokeWidth={2.2} /> : <span>選ぶ</span>}</button>
            <button className={selectionQuestionTarget === "gemini" ? "is-selected" : ""} type="button" role="radio" aria-checked={selectionQuestionTarget === "gemini"} disabled={busy} onClick={() => chooseSelectionQuestionTarget("gemini")}><BrandGlyph name="loop" /><span><strong>Gemini</strong><small>Antigravityで答える</small></span>{selectionQuestionTarget === "gemini" ? <Check size={17} strokeWidth={2.2} /> : <span>選ぶ</span>}</button>
            <button className={selectionQuestionTarget === "local" ? "is-selected" : ""} type="button" role="radio" aria-checked={selectionQuestionTarget === "local"} disabled={busy} onClick={() => chooseSelectionQuestionTarget("local")}><BrandGlyph name="dx" /><span><strong>このPCのAI</strong><small>Gemma 4 E2Bで答える</small></span>{selectionQuestionTarget === "local" ? <Check size={17} strokeWidth={2.2} /> : <span>選ぶ</span>}</button>
          </div>
        </section>
        <div className="settings-list direct-input-settings"><article><span className="setting-icon"><BrandGlyph name="move" /></span><div><h2>カーソル位置へ入力</h2><p>{directInputAllowed ? "ほかのアプリへ直接入力できます。" : "macOSのアクセシビリティ許可が必要です。"}</p></div><span className={directInputAllowed ? "setting-state state-permitted" : "setting-state state-unavailable"}>{directInputAllowed ? <Check size={15} strokeWidth={2.3} /> : <CircleAlert size={15} strokeWidth={2} />}{directInputAllowed ? "許可済み" : "未許可"}</span>{isMac ? <button className="outline-action" type="button" onClick={() => void (directInputAllowed ? openDirectInputSettings() : requestDirectInputPermission())}>{directInputAllowed ? "設定を開く" : "許可する"} <ExternalLink size={15} /></button> : <span />}</article></div>
        <div className="settings-list microphone-settings"><article><span className="setting-icon"><Mic size={22} strokeWidth={1.8} /></span><div><h2>マイク</h2><p>{microphonePermissionState === "granted" ? "このPCのマイクを使えます。" : microphonePermissionState === "unsupported" ? "この環境ではマイクを使えません。" : "初回にこのボタンからマイクを許可します。"}</p></div><span className={microphonePermissionState === "granted" ? "setting-state state-permitted" : "setting-state state-unavailable"}>{microphonePermissionState === "granted" ? <Check size={15} strokeWidth={2.3} /> : <CircleAlert size={15} strokeWidth={2} />}{microphonePermissionState === "granted" ? "許可済み" : microphonePermissionState === "unsupported" ? "利用不可" : "許可が必要"}</span><button className="outline-action" type="button" onClick={() => void requestMicrophonePermission()} disabled={microphonePermissionState === "granted" || microphonePermissionState === "unsupported"}>{microphonePermissionState === "granted" ? "許可済み" : "マイクを許可する"} <Mic size={15} /></button></article></div>
        <div className="settings-list transcription-settings"><article><span className="setting-icon"><BrandGlyph name="work" /></span><div><h2>音声認識</h2><p>{transcription?.downloaded ? "日本語音声認識をこのPCで行います。" : "話した言葉を文字にする日本語モデルです。"}</p>{progressFor("transcription") && <div className="installation-progress" role="status"><span>{progressFor("transcription")?.phase}</span><strong>{installationProgressLabel(progressFor("transcription")!, installationNow)}</strong><i aria-hidden="true"><b style={{ width: `${progressPercent("transcription") ?? 8}%` }} /></i></div>}</div><span className={transcription?.downloaded ? "setting-state state-installed" : "setting-state state-unavailable"}>{transcription?.downloaded ? <Check size={15} strokeWidth={2.3} /> : <Download size={15} strokeWidth={2} />}{transcription?.downloaded ? "モデル取得済み" : downloadingTranscription ? `${progressPercent("transcription") ?? "…"}%` : transcription?.size || "未取得"}</span>{transcription?.downloaded ? <span /> : <button className="outline-action" type="button" onClick={() => void downloadTranscriptionModel()} disabled={downloadingTranscription}>{downloadingTranscription ? "取得中" : "モデルを取得"} <Download size={15} /></button>}</article></div>
        <div className="settings-list">{providers.map(({ id, label, glyph }) => { const status = providerDisplayState(id, false); const connecting = connectingProviders[id]; const loggedIn = connectedProviders[id] && statuses[id]?.authenticated; const unavailable = statuses[id]?.usability === "unavailable"; const detail = id === "codex" ? "GPT-5.6 Lunaで高速整形" : id === "gemini" ? "Gemini 3.6 Flash (Low)で高速整形" : unavailable ? "現在の契約ではClaude Codeを利用できません" : "Claude Haikuで高速整形"; return <article key={id}><span className="setting-icon"><BrandGlyph name={glyph} /></span><div><h2>{label}</h2><p>{detail}</p></div><span className={`setting-state ${status.className}`}>{connecting ? <span className="state-connecting-mark" aria-hidden="true" /> : unavailable ? <CircleAlert size={15} strokeWidth={2} /> : loggedIn ? <Check size={15} strokeWidth={2.3} /> : statuses[id]?.installed ? <span className="state-ring" aria-hidden="true" /> : <CircleAlert size={15} strokeWidth={2} />}{status.label}</span><button className="outline-action" type="button" onClick={() => void connect(id)} disabled={connecting}>{connecting ? "ログイン中" : loggedIn ? "再ログイン" : "ログインする"} {!connecting && <ExternalLink size={15} strokeWidth={1.9} />}</button></article>; })}<article><span className="setting-icon"><BrandGlyph name="dx" /></span><div><h2>ローカルAI</h2><p>{localReady ? "Gemma 4 E2BがこのPCで稼働中です。" : "Gemma 4 E2BをDOON Voice用に取得します。"}</p>{(progressFor("ollama") || progressFor("local_model")) && <div className="installation-progress" role="status"><span>{(progressFor("ollama") || progressFor("local_model"))?.phase}</span><strong>{installationProgressLabel((progressFor("ollama") || progressFor("local_model"))!, installationNow)}</strong><i aria-hidden="true"><b style={{ width: `${progressPercent("ollama") ?? progressPercent("local_model") ?? 8}%` }} /></i></div>}</div><span className={localReady ? "setting-state state-running" : "setting-state state-unavailable"}>{localReady ? <span className="state-live-dot" aria-hidden="true" /> : <WifiOff size={15} strokeWidth={2} />}{localReady ? "稼働中" : installingOllama || pullingLocalModel ? `${progressPercent("ollama") ?? progressPercent("local_model") ?? "…"}%` : "未準備"}</span>{!local?.installed ? <button className="outline-action" type="button" onClick={() => void installOllama()} disabled={installingOllama}>{installingOllama ? "Ollamaを取得中" : "Ollamaを自動インストール"} <Download size={15} /></button> : !localModel?.installed ? <button className="outline-action" type="button" onClick={() => void pullModel()} disabled={pullingLocalModel}>{pullingLocalModel ? "取得中" : "Gemmaを取得"} <Download size={15} /></button> : <span />}</article><article className="shortcut-row"><span className="setting-icon"><BrandGlyph name="speed" /></span><div><h2>開始・停止キー</h2><p>{capturingShortcut ? "押した組み合わせを登録します。Escで取り消せます。" : "通常の音声入力の開始と停止"}</p></div><button ref={shortcutButtonRef} className={capturingShortcut ? "shortcut-key is-capturing" : "shortcut-key"} type="button" onClick={() => void beginShortcutCapture()} aria-label="開始・停止キーを変更" aria-pressed={capturingShortcut}>{capturingShortcut ? "キーを押す" : shortcutLabel(shortcut, navigator.userAgent.includes("Mac"))}</button><button className="outline-action" type="button" onClick={() => void applyShortcut(DEFAULT_SHORTCUT)}>標準に戻す</button></article><article className="shortcut-row"><span className="setting-icon"><BrandGlyph name="speed" /></span><div><h2>選択文を質問するキー</h2><p>{capturingSelectionQuestionShortcut ? "押した組み合わせを登録します。Escで取り消せます。" : "選択中の文章へ音声で質問"}</p></div><button ref={selectionQuestionShortcutButtonRef} className={capturingSelectionQuestionShortcut ? "shortcut-key is-capturing" : "shortcut-key"} type="button" onClick={() => void beginSelectionQuestionShortcutCapture()} aria-label="選択文を質問するキーを変更" aria-pressed={capturingSelectionQuestionShortcut}>{capturingSelectionQuestionShortcut ? "キーを押す" : shortcutLabel(selectionQuestionShortcut, navigator.userAgent.includes("Mac"))}</button><button className="outline-action" type="button" onClick={() => void applySelectionQuestionShortcut(DEFAULT_SELECTION_QUESTION_SHORTCUT)}>標準に戻す</button></article></div>{notice && <p className="notice" role="status">{notice}</p>}</section>}
    </section>

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
          <div className="question-compose-actions"><button className={questionPhase === "recording" ? "outline-action is-recording" : "outline-action"} type="button" onClick={() => void toggleQuestionVoice()} disabled={questionPhase === "transcribing" || questionPhase === "answering"}>{questionPhase === "recording" ? "録音を止める" : "音声で質問"}</button><button className="outline-action question-send" type="button" onClick={() => void askSelectionQuestion()} disabled={!questionDraft.trim() || questionPhase === "recording" || questionPhase === "transcribing" || questionPhase === "answering"}>質問する</button></div>
        </div>
        {questionAnswer && <div className="question-answer-actions"><button className="outline-action" type="button" onClick={() => void copyQuestionAnswer()}>回答をコピー</button><button className="outline-action question-send" type="button" onClick={() => void pasteQuestionAnswer()}>カーソル位置へ入力</button></div>}
      </section>
    </div>}

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
      const next = await appInvoke<string>("answer_selection_question", {
        target: payload.target,
        selection: payload.selection,
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
      <header className="question-dialog-header"><div><span>ASK WITH SELECTION</span><h2 id="selection-question-popup-title">選択した文章を質問</h2></div><button className="icon-button" type="button" onClick={() => void appInvoke("close_selection_question_popup")} aria-label="質問を閉じる"><X size={19} strokeWidth={2} /></button></header>
      {!payload && !error && <p className="question-progress" role="status">回答を準備しています</p>}
      {payload && <><p className="question-selection" aria-label="選択した文章">{payload.selection}</p>
        {answer && <section className="question-answer" aria-live="polite"><span>ANSWER</span><div>{answer}</div></section>}
        {error && <p className="question-error" role="alert">{error}</p>}
        <div className="question-compose"><textarea ref={inputRef} value={question} disabled={answering} onChange={(event) => setQuestion(event.target.value)} onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }} onKeyDown={onQuestionKeyDown} placeholder="質問を入力" aria-label="選択した文章への質問" /><div className="question-compose-actions"><button className="outline-action question-send" type="button" onClick={() => void ask()} disabled={!question.trim() || answering}>{answering ? "回答を作成中" : "質問する"}</button></div></div>
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
