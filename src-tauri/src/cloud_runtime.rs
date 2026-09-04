use serde_json::{json, Value};
use std::{
    ffi::OsString,
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
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

    pub(crate) fn warm(&self, spec: CloudSpec) -> Result<(), String> {
        let mut slot = self
            .slot(spec.kind)
            .lock()
            .map_err(|_| "クラウドAIの常駐接続を準備できませんでした。".to_string())?;
        ensure_client(&mut slot, &spec).map(|_| ())
    }

    pub(crate) fn rewrite(&self, spec: CloudSpec, prompt: &str) -> Result<String, String> {
        let mut slot = self
            .slot(spec.kind)
            .lock()
            .map_err(|_| "クラウドAIの常駐接続を利用できませんでした。".to_string())?;
        let result = ensure_client(&mut slot, &spec)?.rewrite(prompt, spec.timeout);
        if result.is_err() {
            *slot = None;
        }
        result
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

struct JsonLineProcess {
    child: Child,
    stdin: ChildStdin,
    messages: mpsc::Receiver<Value>,
    stderr: Arc<Mutex<String>>,
}

impl JsonLineProcess {
    fn spawn(mut command: Command) -> Result<Self, String> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| error.to_string())?;
        let stdin = child
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
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(message) = serde_json::from_str::<Value>(&line) {
                    if sender.send(message).is_err() {
                        break;
                    }
                }
            }
        });

        let stderr = Arc::new(Mutex::new(String::new()));
        let captured = Arc::clone(&stderr);
        thread::spawn(move || {
            let mut text = String::new();
            let _ = BufReader::new(stderr_reader)
                .take(32 * 1024)
                .read_to_string(&mut text);
            if let Ok(mut output) = captured.lock() {
                *output = text;
            }
        });

        Ok(Self {
            child,
            stdin,
            messages,
            stderr,
        })
    }

    fn send(&mut self, message: &Value) -> Result<(), String> {
        serde_json::to_writer(&mut self.stdin, message)
            .map_err(|_| "CLIへ文章を渡せませんでした。".to_string())?;
        self.stdin
            .write_all(b"\n")
            .and_then(|_| self.stdin.flush())
            .map_err(|_| "CLIへ文章を渡せませんでした。".to_string())
    }

    fn receive(&self, deadline: Instant) -> Result<Value, String> {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("CLIの応答が時間切れになりました。".into());
        }
        self.messages
            .recv_timeout(remaining)
            .map_err(|error| match error {
                mpsc::RecvTimeoutError::Timeout => "CLIの応答が時間切れになりました。".into(),
                mpsc::RecvTimeoutError::Disconnected => self.failure_detail(),
            })
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

        let mut output = String::new();
        loop {
            let message = self.process.receive(deadline)?;
            if let Some(error) = rpc_error(&message) {
                return Err(error);
            }
            if let Some(delta) = codex_delta(&message) {
                output.push_str(delta);
            } else if let Some(final_text) = codex_completed_message(&message) {
                if output.is_empty() {
                    output.push_str(final_text);
                }
            }
            if codex_turn_completed(&message) {
                return nonempty(output, "Codexから文章を受け取れませんでした。");
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
            if !self.process.is_alive() {
                return Err(self.process.failure_detail());
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
        if let Some(error) = rpc_error(&message) {
            return Err(error);
        }
        if message.get("id").and_then(Value::as_u64) == Some(id) {
            return Ok(message);
        }
    }
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

pub(crate) fn codex_delta(message: &Value) -> Option<&str> {
    (message.get("method").and_then(Value::as_str) == Some("item/agentMessage/delta"))
        .then(|| message.pointer("/params/delta").and_then(Value::as_str))
        .flatten()
}

fn codex_completed_message(message: &Value) -> Option<&str> {
    (message.get("method").and_then(Value::as_str) == Some("item/completed"))
        .then(|| {
            message
                .pointer("/params/item")
                .filter(|item| item.get("type").and_then(Value::as_str) == Some("agentMessage"))
                .and_then(|item| item.get("text"))
                .and_then(Value::as_str)
        })
        .flatten()
}

pub(crate) fn codex_turn_completed(message: &Value) -> bool {
    message.get("method").and_then(Value::as_str) == Some("turn/completed")
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
    fn codexの差分応答を連結できる() {
        let first = json!({
            "method": "item/agentMessage/delta",
            "params": {"delta": "明日の会議は"}
        });
        let second = json!({
            "method": "item/agentMessage/delta",
            "params": {"delta": "10時です。"}
        });
        assert_eq!(codex_delta(&first), Some("明日の会議は"));
        assert_eq!(codex_delta(&second), Some("10時です。"));
        assert!(codex_turn_completed(&json!({"method": "turn/completed"})));
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
            };
            runtime.warm(make_spec()).expect("常駐接続を開始できる");
            let first = runtime.process_id(kind).expect("プロセスIDを取得できる");
            runtime.warm(make_spec()).expect("既存接続を再利用できる");
            assert_eq!(runtime.process_id(kind), Some(first));
        }
    }

    #[test]
    #[ignore = "公式クラウドAIへ無害な短文を送る実通信テスト"]
    fn chatgptとgeminiの常駐接続から最終文章を受け取る() {
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
            };
            let first = runtime
                .rewrite(make_spec(), prompt)
                .expect("常駐接続から文章を受け取れる");
            let process_id = runtime.process_id(kind).expect("プロセスIDを取得できる");
            let second = runtime
                .rewrite(make_spec(), prompt)
                .expect("同じ常駐接続から2回目の文章を受け取れる");
            assert!(first.contains("10時"));
            assert!(second.contains("10時"));
            assert_eq!(runtime.process_id(kind), Some(process_id));
        }
    }
}
