use serde_json::{json, Value};
use std::{
    ffi::OsString,
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex, MutexGuard, TryLockError,
    },
    thread,
    time::{Duration, Instant},
};

const CODEX_INSTRUCTIONS: &str =
    "文章整形だけを行う。シェル、ツール、検索、ファイル操作は使わず、本文だけを返す。";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CloudKind {
    Codex,
    Claude,
    Gemini,
}

pub(crate) struct CloudSpec {
    pub kind: CloudKind,
    pub executable: PathBuf,
    pub path: OsString,
    pub cwd: PathBuf,
    pub model: String,
    pub timeout: Duration,
    pub cancelled: Arc<AtomicBool>,
}

#[derive(Default)]
pub(crate) struct CloudRuntime {
    codex: Mutex<Option<CloudClient>>,
    claude: Mutex<Option<CloudClient>>,
    gemini: Mutex<Option<CloudClient>>,
}

impl CloudRuntime {
    pub(crate) fn reset(&self, kind: CloudKind) {
        if let Ok(mut slot) = self.slot(kind).lock() {
            *slot = None;
        }
    }

    pub(crate) fn warm(&self, mut spec: CloudSpec) -> Result<(), String> {
        let deadline = Instant::now() + spec.timeout;
        let mut slot = self.acquire_slot(&spec, deadline)?;
        spec.timeout = remaining_cloud_time(deadline)?;
        ensure_client(&mut slot, &spec).map(|_| ())
    }

    pub(crate) fn rewrite(&self, mut spec: CloudSpec, prompt: &str) -> Result<String, String> {
        let deadline = Instant::now() + spec.timeout;
        let mut slot = self.acquire_slot(&spec, deadline)?;
        let result = (|| {
            spec.timeout = remaining_cloud_time(deadline)?;
            let client = ensure_client(&mut slot, &spec)?;
            client.set_cancellation(Arc::clone(&spec.cancelled));
            client.rewrite(prompt, remaining_cloud_time(deadline)?)
        })();
        // A stream-json process is one conversation. Only Codex supports a
        // fresh ephemeral thread while keeping the same process alive.
        if result.is_err() || !matches!(spec.kind, CloudKind::Codex) {
            *slot = None;
        }
        result
    }

    fn acquire_slot<'a>(
        &'a self,
        spec: &CloudSpec,
        deadline: Instant,
    ) -> Result<MutexGuard<'a, Option<CloudClient>>, String> {
        loop {
            if spec.cancelled.load(Ordering::Acquire) {
                return Err("文章整形を中止しました。原文はDOON Voiceで確認できます。".into());
            }
            let remaining = remaining_cloud_time(deadline)?;
            match self.slot(spec.kind).try_lock() {
                Ok(slot) => return Ok(slot),
                Err(TryLockError::WouldBlock) => {
                    thread::sleep(remaining.min(Duration::from_millis(20)));
                }
                Err(TryLockError::Poisoned(_)) => {
                    return Err("クラウドAIの接続状態を確認できませんでした。".into());
                }
            }
        }
    }

    fn slot(&self, kind: CloudKind) -> &Mutex<Option<CloudClient>> {
        match kind {
            CloudKind::Codex => &self.codex,
            CloudKind::Claude => &self.claude,
            CloudKind::Gemini => &self.gemini,
        }
    }

    #[cfg(test)]
    fn process_id(&self, kind: CloudKind) -> Option<u32> {
        self.slot(kind)
            .lock()
            .ok()
            .and_then(|slot| slot.as_ref().map(CloudClient::process_id))
    }
}

fn remaining_cloud_time(deadline: Instant) -> Result<Duration, String> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        Err("CLIの応答が時間切れになりました。".into())
    } else {
        Ok(remaining)
    }
}

fn ensure_client<'a>(
    slot: &'a mut Option<CloudClient>,
    spec: &CloudSpec,
) -> Result<&'a mut CloudClient, String> {
    let needs_start = match slot.as_mut() {
        Some(client) => !client.is_alive(),
        None => true,
    };
    if needs_start {
        *slot = Some(CloudClient::start(spec)?);
    }
    slot.as_mut()
        .ok_or_else(|| "クラウドAIの常駐接続を開始できませんでした。".to_string())
}

enum CloudClient {
    Codex(CodexClient),
    Claude(StreamClient),
    Gemini(StreamClient),
}

impl CloudClient {
    fn set_cancellation(&mut self, cancelled: Arc<AtomicBool>) {
        match self {
            Self::Codex(client) => client.process.cancelled = cancelled,
            Self::Claude(client) | Self::Gemini(client) => client.process.cancelled = cancelled,
        }
    }

    fn start(spec: &CloudSpec) -> Result<Self, String> {
        match spec.kind {
            CloudKind::Codex => CodexClient::start(spec).map(Self::Codex),
            CloudKind::Claude => StreamClient::start(spec).map(Self::Claude),
            CloudKind::Gemini => StreamClient::start(spec).map(Self::Gemini),
        }
    }

    fn is_alive(&mut self) -> bool {
        match self {
            Self::Codex(client) => client.process.is_alive(),
            Self::Claude(client) | Self::Gemini(client) => client.process.is_alive(),
        }
    }

    fn rewrite(&mut self, prompt: &str, timeout: Duration) -> Result<String, String> {
        match self {
            Self::Codex(client) => client.rewrite(prompt, timeout),
            Self::Claude(client) => {
                client.rewrite(prompt, timeout, claude_input, claude_final_result)
            }
            Self::Gemini(client) => {
                client.rewrite(prompt, timeout, gemini_input, gemini_final_result)
            }
        }
    }

    #[cfg(test)]
    fn process_id(&self) -> u32 {
        match self {
            Self::Codex(client) => client.process.child.id(),
            Self::Claude(client) | Self::Gemini(client) => client.process.child.id(),
        }
    }
}

enum JsonLineEvent {
    Message(Value),
    InputFailed,
    OutputClosed,
}

struct JsonLineProcess {
    child: Child,
    stdin: mpsc::SyncSender<Vec<u8>>,
    messages: mpsc::Receiver<JsonLineEvent>,
    stderr: Arc<Mutex<String>>,
    cancelled: Arc<AtomicBool>,
}

impl JsonLineProcess {
    fn spawn(mut command: Command) -> Result<Self, String> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| error.to_string())?;
        let mut stdin_writer = child
            .stdin
            .take()
            .ok_or_else(|| "CLIの入力を準備できませんでした。".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "CLIの出力を準備できませんでした。".to_string())?;
        let stderr_reader = child
            .stderr
            .take()
            .ok_or_else(|| "CLIのエラー出力を準備できませんでした。".to_string())?;

        let (sender, messages) = mpsc::channel();
        let (stdin, inputs) = mpsc::sync_channel::<Vec<u8>>(8);
        let (stderr_finished, stderr_done) = mpsc::channel();
        let errors = sender.clone();
        thread::spawn(move || {
            for input in inputs {
                if stdin_writer
                    .write_all(&input)
                    .and_then(|_| stdin_writer.flush())
                    .is_err()
                {
                    let _ = errors.send(JsonLineEvent::InputFailed);
                    break;
                }
            }
        });
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(message) = serde_json::from_str::<Value>(&line) {
                    if sender.send(JsonLineEvent::Message(message)).is_err() {
                        return;
                    }
                }
            }
            // Queue closure behind every final JSON, even if the child has
            // already exited. stdin may still hold another sender open.
            // Give stderr a bounded chance to finish; inherited pipes must
            // not keep a failed CLI waiting until the full request deadline.
            let _ = stderr_done.recv_timeout(Duration::from_millis(100));
            let _ = sender.send(JsonLineEvent::OutputClosed);
        });

        let stderr = Arc::new(Mutex::new(String::new()));
        let captured = Arc::clone(&stderr);
        thread::spawn(move || {
            let mut reader = BufReader::new(stderr_reader);
            let mut retained = Vec::new();
            let mut buffer = [0_u8; 4_096];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(bytes) => {
                        let keep = bytes.min((32 * 1024_usize).saturating_sub(retained.len()));
                        if keep > 0 {
                            retained.extend_from_slice(&buffer[..keep]);
                            if let Ok(mut output) = captured.lock() {
                                *output = String::from_utf8_lossy(&retained).into_owned();
                            }
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(error) => {
                        if let Ok(mut output) = captured.lock() {
                            if output.is_empty() {
                                *output = format!("CLIのエラー出力を読み取れませんでした: {error}");
                            }
                        }
                        break;
                    }
                }
            }
            let _ = stderr_finished.send(());
        });

        Ok(Self {
            child,
            stdin,
            messages,
            stderr,
            cancelled: Arc::new(AtomicBool::new(false)),
        })
    }

    fn send(&mut self, message: &Value) -> Result<(), String> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err("文章整形を中止しました。原文はDOON Voiceで確認できます。".into());
        }
        let mut bytes =
            serde_json::to_vec(message).map_err(|_| "CLIへ文章を渡せませんでした。".to_string())?;
        bytes.push(b'\n');
        self.stdin
            .try_send(bytes)
            .map_err(|_| "CLIへ文章を渡せませんでした。".to_string())
    }

    fn receive(&self, deadline: Instant) -> Result<Value, String> {
        loop {
            if self.cancelled.load(Ordering::Acquire) {
                return Err("文章整形を中止しました。原文はDOON Voiceで確認できます。".into());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("CLIの応答が時間切れになりました。".into());
            }
            match self
                .messages
                .recv_timeout(remaining.min(Duration::from_millis(100)))
            {
                Ok(JsonLineEvent::Message(message)) => return Ok(message),
                Ok(JsonLineEvent::InputFailed) => {
                    return Err("CLIへ文章を渡せませんでした。".into());
                }
                Ok(JsonLineEvent::OutputClosed) => return Err(self.failure_detail()),
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => return Err(self.failure_detail()),
            }
        }
    }

    fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    fn failure_detail(&self) -> String {
        self.stderr
            .lock()
            .ok()
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty())
            .unwrap_or_else(|| "CLIとの常駐接続が終了しました。".into())
    }
}

impl Drop for JsonLineProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct CodexClient {
    process: JsonLineProcess,
    next_id: u64,
    cwd: String,
    model: String,
}

impl CodexClient {
    fn start(spec: &CloudSpec) -> Result<Self, String> {
        let mut command = Command::new(&spec.executable);
        command
            .args(["app-server", "--stdio"])
            .current_dir(&spec.cwd)
            .env("PATH", &spec.path);
        let mut process = JsonLineProcess::spawn(command)?;
        process.cancelled = Arc::clone(&spec.cancelled);
        process.send(&json!({
            "method": "initialize",
            "id": 0,
            "params": {
                "clientInfo": {"name": "doon_voice", "title": "DOON Voice", "version": env!("CARGO_PKG_VERSION")}
            }
        }))?;
        let deadline = Instant::now() + spec.timeout;
        wait_for_response(&process, 0, deadline)?;
        process.send(&json!({"method": "initialized", "params": {}}))?;
        Ok(Self {
            process,
            next_id: 1,
            cwd: spec.cwd.to_string_lossy().into_owned(),
            model: spec.model.clone(),
        })
    }

    fn rewrite(&mut self, prompt: &str, timeout: Duration) -> Result<String, String> {
        let thread_request_id = self.take_id();
        self.process.send(&codex_thread_start_request(
            thread_request_id,
            &self.cwd,
            &self.model,
        ))?;
        let deadline = Instant::now() + timeout;
        let response = wait_for_response(&self.process, thread_request_id, deadline)?;
        let thread_id = response
            .pointer("/result/thread/id")
            .and_then(Value::as_str)
            .ok_or_else(|| "Codexの一時スレッドを開始できませんでした。".to_string())?;

        let turn_request_id = self.take_id();
        self.process.send(&json!({
            "method": "turn/start",
            "id": turn_request_id,
            "params": {
                "threadId": thread_id,
                "input": [{"type": "text", "text": prompt}],
                "effort": "low"
            }
        }))?;

        let mut turn_id = None;
        let mut completed_items: Vec<Value> = Vec::new();
        let mut early_completions: Vec<Value> = Vec::new();
        loop {
            // A fast turn can finish before the turn/start acknowledgement.
            // Retain its completion until the acknowledgement identifies it.
            let ready_completion = turn_id.as_deref().and_then(|turn_id| {
                early_completions.iter().position(|event| {
                    event.pointer("/params/turn/id").and_then(Value::as_str) == Some(turn_id)
                })
            });
            let message = match ready_completion {
                Some(index) => early_completions.remove(index),
                None => self.process.receive(deadline)?,
            };
            if let Some(error) = rpc_error_for_request(&message, turn_request_id) {
                return Err(error);
            }
            if message.get("id").and_then(Value::as_u64) == Some(turn_request_id) {
                turn_id = message
                    .pointer("/result/turn/id")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                if turn_id.is_none() {
                    return Err("Codexの応答IDを確認できませんでした。".into());
                }
                continue;
            }
            if message.pointer("/params/threadId").and_then(Value::as_str) != Some(thread_id) {
                continue;
            }
            match message.get("method").and_then(Value::as_str) {
                Some("item/completed") => {
                    if turn_id.as_deref().is_some_and(|turn_id| {
                        message.pointer("/params/turnId").and_then(Value::as_str) != Some(turn_id)
                    }) {
                        continue;
                    }
                    // Completed item text is authoritative, not progress deltas.
                    if completed_items.len() >= 128 {
                        return Err("Codexからの応答が多すぎます。".into());
                    }
                    completed_items.push(message);
                }
                Some("turn/completed") => {
                    let completed_turn = message.pointer("/params/turn/id").and_then(Value::as_str);
                    if turn_id.is_none() && completed_turn.is_some() {
                        if early_completions.len() >= 128 {
                            return Err("Codexからの応答が多すぎます。".into());
                        }
                        early_completions.push(message);
                        continue;
                    }
                    if completed_turn.is_none() || completed_turn != turn_id.as_deref() {
                        continue;
                    }
                    if !codex_turn_completed(&message) {
                        return Err(
                            "Codexの文章整形が完了しませんでした。原文を確認してください。".into(),
                        );
                    }
                    let items: Vec<&Value> = message
                        .pointer("/params/turn/items")
                        .and_then(Value::as_array)
                        .filter(|items| !items.is_empty())
                        .map(|items| items.iter().collect())
                        .unwrap_or_else(|| {
                            completed_items
                                .iter()
                                .filter(|event| {
                                    event.pointer("/params/turnId").and_then(Value::as_str)
                                        == completed_turn
                                })
                                .filter_map(|event| event.pointer("/params/item"))
                                .collect()
                        });
                    let final_item = items.iter().rev().copied().find(|item| {
                        item.get("type").and_then(Value::as_str) == Some("agentMessage")
                            && item.get("phase").and_then(Value::as_str) == Some("final_answer")
                    });
                    // Older models omit phase: use only the last completed
                    // assistant item, never concatenate unrelated messages.
                    let legacy_item = items.iter().rev().copied().find(|item| {
                        item.get("type").and_then(Value::as_str) == Some("agentMessage")
                            && item.get("phase").is_none_or(Value::is_null)
                    });
                    let output = final_item
                        .or(legacy_item)
                        .and_then(|item| item.get("text"))
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    return nonempty(output.to_string(), "Codexから文章を受け取れませんでした。");
                }
                _ => {}
            }
        }
    }

    fn take_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1);
        id
    }
}

struct StreamClient {
    process: JsonLineProcess,
}

type InputBuilder = fn(&str) -> Value;
type ResultParser = for<'a> fn(&'a Value) -> Result<Option<&'a str>, String>;

impl StreamClient {
    fn start(spec: &CloudSpec) -> Result<Self, String> {
        let mut command = Command::new(&spec.executable);
        match spec.kind {
            CloudKind::Claude => {
                command.args([
                    "-p",
                    "--model",
                    &spec.model,
                    "--effort",
                    "low",
                    "--safe-mode",
                    "--tools",
                    "",
                    "--no-session-persistence",
                    "--input-format",
                    "stream-json",
                    "--output-format",
                    "stream-json",
                    "--verbose",
                ]);
            }
            CloudKind::Gemini => {
                command.args([
                    "--model",
                    &spec.model,
                    "--disable-slash-commands",
                    "--input-format",
                    "stream-json",
                    "--output-format",
                    "stream-json",
                    "--print-timeout",
                    "45s",
                ]);
                command.env("AGY_CLI_HIDE_LOGO", "1");
            }
            CloudKind::Codex => return Err("Codexの接続方式が不正です。".into()),
        }
        command.current_dir(&spec.cwd).env("PATH", &spec.path);
        Ok(Self {
            process: JsonLineProcess::spawn(command)?,
        })
    }

    fn rewrite(
        &mut self,
        prompt: &str,
        timeout: Duration,
        input: InputBuilder,
        parser: ResultParser,
    ) -> Result<String, String> {
        self.process.send(&input(prompt))?;
        let deadline = Instant::now() + timeout;
        loop {
            let message = self.process.receive(deadline)?;
            if let Some(result) = parser(&message)? {
                return nonempty(
                    result.to_string(),
                    "クラウドAIから文章を受け取れませんでした。",
                );
            }
        }
    }
}

fn wait_for_response(
    process: &JsonLineProcess,
    id: u64,
    deadline: Instant,
) -> Result<Value, String> {
    loop {
        let message = process.receive(deadline)?;
        if let Some(error) = rpc_error_for_request(&message, id) {
            return Err(error);
        }
        if message.get("id").and_then(Value::as_u64) == Some(id) {
            return Ok(message);
        }
    }
}

fn rpc_error_for_request(message: &Value, request_id: u64) -> Option<String> {
    if message
        .get("id")
        .is_some_and(|id| id.as_u64() != Some(request_id))
    {
        return None;
    }
    rpc_error(message)
}

fn rpc_error(message: &Value) -> Option<String> {
    message
        .get("error")
        .and_then(|error| error.get("message").or(Some(error)))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn nonempty(text: String, message: &str) -> Result<String, String> {
    if text.trim().is_empty() {
        Err(message.into())
    } else {
        Ok(text)
    }
}

pub(crate) fn codex_thread_start_request(id: u64, cwd: &str, model: &str) -> Value {
    json!({
        "method": "thread/start",
        "id": id,
        "params": {
            "cwd": cwd,
            "approvalPolicy": "never",
            "sandbox": "read-only",
            "ephemeral": true,
            "model": model,
            "serviceName": "doon_voice",
            "developerInstructions": CODEX_INSTRUCTIONS
        }
    })
}

pub(crate) fn codex_turn_completed(message: &Value) -> bool {
    message.get("method").and_then(Value::as_str) == Some("turn/completed")
        && message
            .pointer("/params/turn/status")
            .and_then(Value::as_str)
            == Some("completed")
        && message
            .pointer("/params/turn/error")
            .is_none_or(Value::is_null)
}

pub(crate) fn claude_input(prompt: &str) -> Value {
    json!({
        "type": "user",
        "message": {"role": "user", "content": prompt}
    })
}

pub(crate) fn claude_final_result(message: &Value) -> Result<Option<&str>, String> {
    if message.get("type").and_then(Value::as_str) != Some("result") {
        return Ok(None);
    }
    if message.get("is_error").and_then(Value::as_bool) == Some(true)
        || message.get("subtype").and_then(Value::as_str) == Some("error")
    {
        return Err(message
            .get("result")
            .and_then(Value::as_str)
            .unwrap_or("Claudeで文章を整えられませんでした。")
            .to_string());
    }
    Ok(message.get("result").and_then(Value::as_str))
}

pub(crate) fn gemini_input(prompt: &str) -> Value {
    json!({"event": "user", "message": {"content": prompt}})
}

pub(crate) fn gemini_final_result(message: &Value) -> Result<Option<&str>, String> {
    if message.get("event").and_then(Value::as_str) != Some("result") {
        return Ok(None);
    }
    let Some(result) = message.get("result") else {
        return Err("Geminiで文章を整えられませんでした。".into());
    };
    if result.get("status").and_then(Value::as_str) == Some("SUCCESS") {
        return Ok(result.get("response").and_then(Value::as_str));
    }
    Err(result
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("Geminiで文章を整えられませんでした。")
        .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exit_fixture_command(mode: &str) -> Command {
        let fixture = format!(
            "{}::json_line_exit_fixture",
            module_path!().split_once("::").unwrap().1
        );
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", &fixture, "--nocapture"])
            .env("DOON_VOICE_TEST_EXIT_MODE", mode);
        command
    }

    #[test]
    fn json_line_exit_fixture() {
        let Ok(mode) = std::env::var("DOON_VOICE_TEST_EXIT_MODE") else {
            return;
        };
        if mode == "delayed-stderr-writer" {
            thread::sleep(Duration::from_millis(30));
            std::io::stderr()
                .write_all(b"fixture delayed startup rejection")
                .unwrap();
            std::process::exit(7);
        }
        let mut line = String::new();
        std::io::stdin().read_line(&mut line).unwrap();
        let _: Value = serde_json::from_str(&line).unwrap();
        match mode.as_str() {
            #[cfg(windows)]
            "console" => {
                #[link(name = "kernel32")]
                unsafe extern "system" { fn GetConsoleWindow() -> *mut std::ffi::c_void; }
                // SAFETY: GetConsoleWindow has no arguments and does not transfer ownership.
                println!("{}", json!({"has_console": !unsafe { GetConsoleWindow() }.is_null()}));
            }
            "stderr-exit" => {
                std::io::stderr()
                    .write_all(b"fixture startup rejection")
                    .unwrap();
                std::process::exit(7);
            }
            "silent-exit" => std::process::exit(7),
            "delayed-stderr-exit" => {
                exit_fixture_command("delayed-stderr-writer")
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::inherit())
                    .spawn()
                    .unwrap();
                std::process::exit(7);
            }
            "claude-final-exit" | "gemini-final-exit" => {
                println!("{}", json!({"phase": "fixture-progress"}));
                let result = if mode == "claude-final-exit" {
                    json!({"type": "result", "is_error": false, "result": "最後の本文です。"})
                } else {
                    json!({"event": "result", "result": {"status": "SUCCESS", "response": "最後の本文です。"}})
                };
                // The final valid JSON need not have a trailing newline.
                print!("{result}");
                std::io::stdout().flush().unwrap();
                std::process::exit(0);
            }
            "waiting" => thread::sleep(Duration::from_secs(5)),
            _ => panic!("unknown exit fixture mode"),
        }
    }

    #[test]
    fn json_line_stderr_only_exit_returns_detail_without_waiting_for_deadline() {
        let mut client = StreamClient {
            process: JsonLineProcess::spawn(exit_fixture_command("stderr-exit")).unwrap(),
        };
        let started = Instant::now();
        let error = client
            .rewrite(
                "人工的なテスト文",
                Duration::from_secs(2),
                claude_input,
                claude_final_result,
            )
            .unwrap_err();
        assert_eq!(error, "fixture startup rejection");
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[cfg(windows)]
    #[test]
    fn windows_json_line_process_has_no_console() {
        use std::os::windows::process::CommandExt;
        let mut command = exit_fixture_command("console");
        command.creation_flags(0x0000_0010); // CREATE_NEW_CONSOLE
        let mut process = JsonLineProcess::spawn(command).unwrap();
        process.send(&json!({"id": 0})).unwrap();
        let response = process.receive(Instant::now() + Duration::from_secs(5)).unwrap();
        assert_eq!(response["has_console"], false);
    }

    #[test]
    fn json_line_silent_exit_is_reported_before_the_deadline() {
        let mut process = JsonLineProcess::spawn(exit_fixture_command("silent-exit")).unwrap();
        process
            .send(&json!({"id": 0, "method": "initialize"}))
            .unwrap();
        let started = Instant::now();
        let error = wait_for_response(&process, 0, started + Duration::from_secs(2)).unwrap_err();
        assert_eq!(error, "CLIとの常駐接続が終了しました。");
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn json_line_exit_waits_briefly_for_stderr_to_finish() {
        let mut process =
            JsonLineProcess::spawn(exit_fixture_command("delayed-stderr-exit")).unwrap();
        process
            .send(&json!({"id": 0, "method": "initialize"}))
            .unwrap();
        let started = Instant::now();
        let error = process
            .receive(started + Duration::from_secs(2))
            .unwrap_err();
        assert_eq!(error, "fixture delayed startup rejection");
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn json_line_final_response_before_exit_survives_queued_progress() {
        for mode in ["claude-final-exit", "gemini-final-exit"] {
            let mut client = StreamClient {
                process: JsonLineProcess::spawn(exit_fixture_command(mode)).unwrap(),
            };
            let result = client.rewrite(
                "人工的なテスト文",
                Duration::from_secs(2),
                claude_input,
                |message| {
                    if message["phase"] == "fixture-progress" {
                        // Let the CLI finish before handling its queued final response.
                        thread::sleep(Duration::from_millis(100));
                    }
                    if message.get("event").is_some() {
                        gemini_final_result(message)
                    } else {
                        claude_final_result(message)
                    }
                },
            );
            assert_eq!(result.unwrap(), "最後の本文です。", "mode={mode}");
        }
    }

    #[test]
    fn json_line_live_unresponsive_process_still_observes_the_deadline() {
        let mut process = JsonLineProcess::spawn(exit_fixture_command("waiting")).unwrap();
        process
            .send(&json!({"id": 0, "method": "initialize"}))
            .unwrap();
        let started = Instant::now();
        let error = process
            .receive(started + Duration::from_millis(150))
            .unwrap_err();
        assert!(error.contains("時間切れ"));
        assert!(started.elapsed() >= Duration::from_millis(150));
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(process.is_alive());
    }

    #[test]
    fn codex_fixture() {
        let Ok(mode) = std::env::var("DOON_VOICE_TEST_CODEX_FIXTURE") else {
            return;
        };
        let emit = |value: Value| {
            println!("{value}");
            std::io::stdout().flush().unwrap();
        };
        for line in std::io::stdin().lock().lines() {
            let value: Value = serde_json::from_str(&line.unwrap()).unwrap();
            if value["method"] == "thread/start" {
                emit(json!({"id": value["id"], "result": {"thread": {"id": "thread-test"}}}));
            } else if value["method"] == "turn/start" {
                if mode != "completion-before-ack" {
                    emit(json!({"id": value["id"], "result": {"turn": {"id": "turn-test"}}}));
                }
                if mode == "waiting" {
                    thread::sleep(Duration::from_secs(5));
                    continue;
                }
                if mode == "unrelated-rpc-error" {
                    emit(json!({"id": 9999, "error": {"message": "unrelated request failed"}}));
                }
                if mode == "large-stderr" {
                    std::io::stderr()
                        .write_all(&vec![b'x'; 512 * 1024])
                        .unwrap();
                }
                for (id, phase, text) in [
                    ("one", "commentary", "整えます。"),
                    ("two", "final_answer", "明日は会議です。"),
                ] {
                    emit(
                        json!({"method": "item/agentMessage/delta", "params": {"threadId": "thread-test", "turnId": "turn-test", "itemId": id, "delta": text}}),
                    );
                    emit(
                        json!({"method": "item/completed", "params": {"threadId": "thread-test", "turnId": "turn-test", "item": {"id": id, "type": "agentMessage", "phase": phase, "text": text}}}),
                    );
                }
                emit(
                    json!({"method": "turn/completed", "params": {"threadId": "another-thread", "turn": {"id": "another-turn", "status": "completed", "items": []}}}),
                );
                emit(
                    json!({"method": "item/completed", "params": {"threadId": "thread-test", "turnId": "another-turn", "item": {"type": "agentMessage", "phase": "final_answer", "text": "別の発話。"}}}),
                );
                emit(
                    json!({"method": "turn/completed", "params": {"threadId": "thread-test", "turn": {"id": "another-turn", "status": "failed", "error": {"message": "別の発話の失敗"}, "items": []}}}),
                );
                let status = if [
                    "completion-before-ack",
                    "unrelated-rpc-error",
                    "large-stderr",
                    "empty-final",
                ]
                .contains(&mode.as_str())
                {
                    "completed"
                } else {
                    &mode
                };
                let items = if mode == "empty-final" {
                    json!([{"type": "agentMessage", "phase": "final_answer", "text": " "}])
                } else {
                    json!([])
                };
                emit(
                    json!({"method": "turn/completed", "params": {"threadId": "thread-test", "turn": {"id": "turn-test", "status": status, "items": items, "error": if mode == "failed" {json!({"message": "fixture failed"})} else {Value::Null}}}}),
                );
                if mode == "completion-before-ack" {
                    emit(json!({"id": value["id"], "result": {"turn": {"id": "turn-test"}}}));
                }
            }
        }
    }

    #[test]
    fn codex_uses_only_final_answer_and_rejects_failed_turns() {
        for mode in ["completed", "failed", "interrupted"] {
            let fixture = format!(
                "{}::codex_fixture",
                module_path!().split_once("::").unwrap().1
            );
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .args(["--exact", &fixture, "--nocapture"])
                .env("DOON_VOICE_TEST_CODEX_FIXTURE", mode);
            let mut client = CodexClient {
                process: JsonLineProcess::spawn(command).unwrap(),
                next_id: 1,
                cwd: std::env::temp_dir().to_string_lossy().into_owned(),
                model: "fixture".into(),
            };
            let result = client.rewrite("人工的なテスト文", Duration::from_secs(5));
            if mode == "completed" {
                assert_eq!(result.unwrap(), "明日は会議です。");
            } else {
                assert!(result.is_err(), "{mode}: {result:?}");
            }
        }
    }

    fn fake_codex(mode: &str) -> CodexClient {
        let fixture = format!(
            "{}::codex_fixture",
            module_path!().split_once("::").unwrap().1
        );
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", &fixture, "--nocapture"])
            .env("DOON_VOICE_TEST_CODEX_FIXTURE", mode);
        CodexClient {
            process: JsonLineProcess::spawn(command).unwrap(),
            next_id: 1,
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
            model: "fixture".into(),
        }
    }

    #[test]
    fn codex_accepts_completion_received_before_turn_start_ack() {
        let mut client = fake_codex("completion-before-ack");
        assert_eq!(
            client
                .rewrite("人工的なテスト文", Duration::from_millis(500))
                .unwrap(),
            "明日は会議です。"
        );
    }

    #[test]
    fn codex_ignores_errors_and_items_for_unrelated_requests_and_turns() {
        let mut client = fake_codex("unrelated-rpc-error");
        assert_eq!(
            client
                .rewrite("人工的なテスト文", Duration::from_secs(2))
                .unwrap(),
            "明日は会議です。"
        );
    }

    #[test]
    fn large_stderr_does_not_break_a_valid_final_answer() {
        let mut client = fake_codex("large-stderr");
        assert_eq!(
            client
                .rewrite("人工的なテスト文", Duration::from_secs(2))
                .unwrap(),
            "明日は会議です。"
        );
    }

    #[test]
    fn empty_final_is_an_error_even_when_commentary_exists() {
        let mut client = fake_codex("empty-final");
        assert!(client
            .rewrite("人工的なテスト文", Duration::from_secs(2))
            .is_err());
    }

    #[test]
    fn pre_cancelled_send_does_not_enqueue_a_prompt() {
        let mut client = fake_codex("completed");
        client.process.cancelled.store(true, Ordering::Release);
        assert!(client
            .process
            .send(&json!({"method": "turn/start", "params": {"input": "人工的なテスト文"}}))
            .is_err());
    }

    #[test]
    fn pre_cancelled_rewrite_does_not_start_a_cli() {
        let runtime = CloudRuntime::default();
        let result = runtime.rewrite(
            CloudSpec {
                kind: CloudKind::Codex,
                executable: PathBuf::from("doon-deliberately-missing-cloud-test-cli"),
                path: std::env::var_os("PATH").unwrap_or_default(),
                cwd: std::env::temp_dir(),
                model: "fixture".into(),
                timeout: Duration::from_secs(1),
                cancelled: Arc::new(AtomicBool::new(true)),
            },
            "人工的なテスト文",
        );
        assert!(result.unwrap_err().contains("中止"));
    }

    fn fake_spec(kind: CloudKind) -> CloudSpec {
        CloudSpec {
            kind,
            executable: PathBuf::from("doon-deliberately-missing-cloud-test-cli"),
            path: std::env::var_os("PATH").unwrap_or_default(),
            cwd: std::env::temp_dir(),
            model: "fixture".into(),
            timeout: Duration::from_secs(2),
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    #[test]
    fn stream_fixture() {
        let Ok(kind) = std::env::var("DOON_VOICE_TEST_STREAM_KIND") else {
            return;
        };
        for line in std::io::stdin().lock().lines() {
            let _: Value = serde_json::from_str(&line.unwrap()).unwrap();
            let result = if kind == "claude" {
                json!({"type": "result", "subtype": "success", "is_error": false, "result": "明日は会議です。"})
            } else {
                json!({"event": "result", "result": {"status": "SUCCESS", "response": "明日は会議です。"}})
            };
            println!("{result}");
            std::io::stdout().flush().unwrap();
        }
    }

    #[test]
    fn claude_and_gemini_release_the_conversation_after_each_rewrite() {
        for (kind, name) in [(CloudKind::Claude, "claude"), (CloudKind::Gemini, "gemini")] {
            let fixture = format!(
                "{}::stream_fixture",
                module_path!().split_once("::").unwrap().1
            );
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .args(["--exact", &fixture, "--nocapture"])
                .env("DOON_VOICE_TEST_STREAM_KIND", name);
            let stream = StreamClient {
                process: JsonLineProcess::spawn(command).unwrap(),
            };
            let runtime = CloudRuntime::default();
            *runtime.slot(kind).lock().unwrap() = Some(match kind {
                CloudKind::Claude => CloudClient::Claude(stream),
                CloudKind::Gemini => CloudClient::Gemini(stream),
                CloudKind::Codex => unreachable!(),
            });
            assert_eq!(
                runtime
                    .rewrite(fake_spec(kind), "人工的なテスト文")
                    .unwrap(),
                "明日は会議です。"
            );
            assert!(runtime.process_id(kind).is_none());
        }
    }

    #[test]
    fn failed_and_empty_codex_results_invalidate_the_client() {
        for mode in ["failed", "interrupted", "empty-final"] {
            let runtime = CloudRuntime::default();
            *runtime.codex.lock().unwrap() = Some(CloudClient::Codex(fake_codex(mode)));
            assert!(runtime
                .rewrite(fake_spec(CloudKind::Codex), "人工的なテスト文")
                .is_err());
            assert!(runtime.process_id(CloudKind::Codex).is_none());
        }
    }

    #[test]
    fn cancellation_during_rewrite_releases_the_client_promptly() {
        let runtime = CloudRuntime::default();
        *runtime.codex.lock().unwrap() = Some(CloudClient::Codex(fake_codex("waiting")));
        let spec = fake_spec(CloudKind::Codex);
        let cancelled = Arc::clone(&spec.cancelled);
        thread::scope(|scope| {
            scope.spawn(move || {
                thread::sleep(Duration::from_millis(50));
                cancelled.store(true, Ordering::Release);
            });
            let started = Instant::now();
            assert!(runtime
                .rewrite(spec, "人工的なテスト文")
                .unwrap_err()
                .contains("中止"));
            assert!(started.elapsed() < Duration::from_secs(1));
        });
        assert!(runtime.process_id(CloudKind::Codex).is_none());
    }

    #[test]
    fn cancellation_is_observed_while_another_operation_holds_the_slot() {
        let runtime = CloudRuntime::default();
        let guard = runtime.codex.lock().unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let (entered_sender, entered) = mpsc::channel();
        let (done_sender, done) = mpsc::channel();
        thread::scope(|scope| {
            let worker_cancelled = Arc::clone(&cancelled);
            let runtime_ref = &runtime;
            scope.spawn(move || {
                let mut spec = fake_spec(CloudKind::Codex);
                spec.cancelled = worker_cancelled;
                entered_sender.send(()).unwrap();
                let result = runtime_ref.rewrite(spec, "人工的なテスト文");
                done_sender.send(result).unwrap();
            });
            entered.recv().unwrap();
            thread::sleep(Duration::from_millis(50));
            cancelled.store(true, Ordering::Release);
            let stopped_promptly = done.recv_timeout(Duration::from_millis(250)).is_ok();
            drop(guard);
            assert!(stopped_promptly, "warm等が接続を使用中でも取消を処理する");
        });
    }

    #[test]
    fn warm_times_out_while_another_operation_holds_the_slot() {
        let runtime = CloudRuntime::default();
        let guard = runtime.codex.lock().unwrap();
        let (done_sender, done) = mpsc::channel();
        thread::scope(|scope| {
            let runtime_ref = &runtime;
            scope.spawn(move || {
                let mut spec = fake_spec(CloudKind::Codex);
                spec.timeout = Duration::from_millis(50);
                done_sender.send(runtime_ref.warm(spec)).unwrap();
            });
            let timed_out = done
                .recv_timeout(Duration::from_millis(250))
                .is_ok_and(|result| result.is_err_and(|error| error.contains("時間")));
            drop(guard);
            assert!(timed_out, "常駐接続の待ち合わせにも実行期限を適用する");
        });
    }

    #[test]
    fn failed_or_interrupted_codex_turn_is_not_success() {
        for status in ["failed", "interrupted", "inProgress"] {
            assert!(
                !codex_turn_completed(&json!({
                    "method": "turn/completed",
                    "params": {"threadId": "t", "turn": {"id": "u", "status": status}}
                })),
                "status={status}"
            );
        }
    }

    #[test]
    fn codexは一時スレッドで文章整形だけを要求する() {
        let request = codex_thread_start_request(7, "/tmp/doon-voice", "gpt-5.6-luna");
        assert_eq!(request["method"], "thread/start");
        assert_eq!(request["id"], 7);
        assert_eq!(request["params"]["ephemeral"], true);
        assert_eq!(request["params"]["approvalPolicy"], "never");
        assert_eq!(request["params"]["sandbox"], "read-only");
        assert!(request["params"]["developerInstructions"]
            .as_str()
            .unwrap_or_default()
            .contains("文章整形だけ"));
    }

    #[test]
    fn codexの成功終了状態を確認する() {
        assert!(!codex_turn_completed(&json!({"method": "turn/completed"})));
        assert!(codex_turn_completed(
            &json!({"method": "turn/completed", "params": {"turn": {"status": "completed"}}})
        ));
    }

    #[test]
    fn claudeとgeminiは一行入力と最終結果だけを使う() {
        let claude = claude_input("本文");
        assert_eq!(claude["type"], "user");
        assert_eq!(claude["message"]["role"], "user");

        let claude_result = json!({
            "type": "result",
            "subtype": "success",
            "is_error": false,
            "result": "整えた本文。"
        });
        assert_eq!(
            claude_final_result(&claude_result).unwrap(),
            Some("整えた本文。")
        );

        let gemini = gemini_input("本文");
        assert_eq!(gemini["event"], "user");
        let gemini_result = json!({
            "event": "result",
            "result": {"status": "SUCCESS", "response": "整えた本文。"}
        });
        assert_eq!(
            gemini_final_result(&gemini_result).unwrap(),
            Some("整えた本文。")
        );
    }

    #[test]
    #[ignore = "端末にインストール済みの公式CLIを使う実機テスト"]
    fn 公式cliプロセスを再利用する() {
        let cwd = std::env::temp_dir().join("doon-voice-cloud-runtime-test");
        std::fs::create_dir_all(&cwd).expect("テスト用作業場所を作成できる");
        let path = std::env::var_os("PATH").unwrap_or_default();
        for (kind, variable, model, timeout) in [
            (CloudKind::Codex, "DOON_VOICE_CODEX", "gpt-5.6-luna", 10),
            (CloudKind::Claude, "DOON_VOICE_CLAUDE", "haiku", 10),
            (
                CloudKind::Gemini,
                "DOON_VOICE_GEMINI",
                "Gemini 3.6 Flash (Low)",
                10,
            ),
        ] {
            let executable = PathBuf::from(std::env::var_os(variable).expect(variable));
            let runtime = CloudRuntime::default();
            let make_spec = || CloudSpec {
                kind,
                executable: executable.clone(),
                path: path.clone(),
                cwd: cwd.clone(),
                model: model.into(),
                timeout: Duration::from_secs(timeout),
                cancelled: Arc::new(AtomicBool::new(false)),
            };
            runtime.warm(make_spec()).expect("常駐接続を開始できる");
            let first = runtime.process_id(kind).expect("プロセスIDを取得できる");
            runtime.warm(make_spec()).expect("既存接続を再利用できる");
            assert_eq!(runtime.process_id(kind), Some(first));
        }
    }

    #[test]
    #[ignore = "公式クラウドAIへ無害な短文を送る実通信テスト"]
    fn chatgptとgeminiは発話分離方針を守って最終文章を受け取る() {
        let cwd = std::env::temp_dir().join("doon-voice-cloud-runtime-live-test");
        std::fs::create_dir_all(&cwd).expect("テスト用作業場所を作成できる");
        let path = std::env::var_os("PATH").unwrap_or_default();
        let prompt = "句読点だけを整え、本文だけ返してください。入力: 明日の会議は10時です 出力:";
        for (kind, variable, model) in [
            (CloudKind::Codex, "DOON_VOICE_CODEX", "gpt-5.6-luna"),
            (
                CloudKind::Gemini,
                "DOON_VOICE_GEMINI",
                "Gemini 3.6 Flash (Low)",
            ),
        ] {
            let runtime = CloudRuntime::default();
            let make_spec = || CloudSpec {
                kind,
                executable: PathBuf::from(std::env::var_os(variable).expect(variable)),
                path: path.clone(),
                cwd: cwd.clone(),
                model: model.into(),
                timeout: Duration::from_secs(90),
                cancelled: Arc::new(AtomicBool::new(false)),
            };
            let first = runtime
                .rewrite(make_spec(), prompt)
                .expect("常駐接続から文章を受け取れる");
            let process_id = runtime.process_id(kind);
            if kind == CloudKind::Codex {
                assert!(process_id.is_some(), "Codexはプロセスを保持する");
            } else {
                assert!(process_id.is_none(), "Geminiは発話完了時に接続を閉じる");
            }
            let second = runtime
                .rewrite(make_spec(), prompt)
                .expect("発話を分離して2回目の文章を受け取れる");
            assert!(first.contains("10時"));
            assert!(second.contains("10時"));
            assert_eq!(runtime.process_id(kind), process_id);
        }
    }
}
