//! 各社のAPIへ直接つなぐ。APIキーはOSの資格情報ストア（macOSのキーチェーン、
//! Windowsの資格情報マネージャー）にだけ保存し、画面側へは返さない。

use crate::Provider;
use serde_json::{json, Value};
use std::time::Duration;

const KEYRING_SERVICE: &str = "com.doon.voice.desktop";
pub(crate) const OPENAI_MODEL: &str = "gpt-6-luna";
pub(crate) const ANTHROPIC_MODEL: &str = "claude-haiku-5-5";
pub(crate) const GEMINI_MODEL: &str = "gemini-3.6-flash";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const MAX_OUTPUT_TOKENS: u32 = 4096;
const API_KEY_MAX_CHARS: usize = 512;
const CLAUDE_IMAGE_MAX_BASE64: usize = 10 * 1024 * 1024;
const MAX_CONTINUATIONS: usize = 3;
const MAX_SOURCES: usize = 5;

const FORMAT_INSTRUCTIONS: &str = "文章整形だけを行う。検索やツールは使わず、本文だけを返す。";
const QUESTION_INSTRUCTIONS: &str = "選択された文章や画面についての質問に答える。最新情報や調査を求められた場合だけWeb検索を使い、確認した事実と出典URLを短く示す。回答本文だけを返す。";

pub(crate) struct CloudRequest<'a> {
    pub prompt: &'a str,
    pub question_mode: bool,
    pub image_data_url: Option<&'a str>,
}

pub(crate) fn provider_label(provider: Provider) -> &'static str {
    match provider {
        Provider::Codex => "ChatGPT",
        Provider::Claude => "Claude",
        Provider::Gemini => "Gemini",
    }
}

fn keyring_account(provider: Provider) -> &'static str {
    match provider {
        Provider::Codex => "openai-api-key",
        Provider::Claude => "anthropic-api-key",
        Provider::Gemini => "gemini-api-key",
    }
}

fn keyring_entry(provider: Provider) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, keyring_account(provider))
        .map_err(|_| "APIキーの保管場所を開けませんでした。".to_string())
}

pub(crate) fn load_key(provider: Provider) -> Result<Option<String>, String> {
    match keyring_entry(provider)?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(format!(
            "{}のAPIキーを読み出せませんでした。OSの確認画面が出た場合は許可してください。",
            provider_label(provider)
        )),
    }
}

pub(crate) fn store_key(provider: Provider, key: &str) -> Result<(), String> {
    keyring_entry(provider)?
        .set_password(key)
        .map_err(|_| "APIキーを保存できませんでした。".to_string())
}

pub(crate) fn delete_key(provider: Provider) -> Result<(), String> {
    match keyring_entry(provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("APIキーを削除できませんでした。".into()),
    }
}

/// 貼り付け時の前後の空白だけを除き、形の崩れたキーは送信前に止める。
pub(crate) fn normalize_key(raw: &str) -> Result<String, String> {
    let key = raw.trim();
    if key.is_empty() {
        return Err("APIキーを入力してください。".into());
    }
    if key.chars().count() > API_KEY_MAX_CHARS
        || key.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(
            "APIキーの形式が正しくありません。コピーしたキーをそのまま貼り付けてください。".into(),
        );
    }
    Ok(key.to_string())
}

static HTTP_CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();

pub(crate) fn http_client() -> Result<reqwest::Client, String> {
    // 接続（TLS）を使い回すため、アプリ全体で1つのクライアントを共有する。
    // 回線が遅い時は接続の作成だけで数秒かかるため、発話ごとに作り直さない。
    if let Some(client) = HTTP_CLIENT.get() {
        return Ok(client.clone());
    }
    // キーを付けた要求が別のホストへ転送されないよう、転送には従わない。
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .pool_idle_timeout(Duration::from_secs(90))
        .tcp_keepalive(Duration::from_secs(30))
        .build()
        .map_err(|_| "通信の準備ができませんでした。".to_string())?;
    Ok(HTTP_CLIENT.get_or_init(|| client).clone())
}

/// 話している間に、選んだAIのAPIへの接続を作っておく。キーも本文も送らない。
pub(crate) async fn preconnect(provider: Provider) {
    let Ok(client) = http_client() else {
        return;
    };
    let _ = client
        .head(request_url(provider))
        .timeout(Duration::from_secs(10))
        .send()
        .await;
}

pub(crate) fn request_timeout(provider: Provider, question_mode: bool) -> Duration {
    match (provider, question_mode) {
        (_, true) => Duration::from_secs(90),
        (Provider::Gemini, false) => Duration::from_secs(45),
        (_, false) => Duration::from_secs(60),
    }
}

fn split_data_url(data_url: &str) -> Option<(&str, &str)> {
    let rest = data_url.strip_prefix("data:")?;
    let (mime, data) = rest.split_once(";base64,")?;
    (mime.starts_with("image/") && !data.is_empty()).then_some((mime, data))
}

pub(crate) fn request_url(provider: Provider) -> String {
    match provider {
        Provider::Codex => "https://api.openai.com/v1/responses".into(),
        Provider::Claude => "https://api.anthropic.com/v1/messages".into(),
        Provider::Gemini => format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
        ),
    }
}

fn model_url(provider: Provider) -> String {
    match provider {
        Provider::Codex => format!("https://api.openai.com/v1/models/{OPENAI_MODEL}"),
        Provider::Claude => format!("https://api.anthropic.com/v1/models/{ANTHROPIC_MODEL}"),
        Provider::Gemini => {
            format!("https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}")
        }
    }
}

pub(crate) fn request_body(provider: Provider, request: &CloudRequest) -> Result<Value, String> {
    let instructions = if request.question_mode {
        QUESTION_INSTRUCTIONS
    } else {
        FORMAT_INSTRUCTIONS
    };
    let image = match request.image_data_url {
        Some(url) => Some(split_data_url(url).ok_or("画面画像の形式が正しくありません。")?),
        None => None,
    };
    Ok(match provider {
        Provider::Codex => {
            let mut content = vec![json!({ "type": "input_text", "text": request.prompt })];
            if let Some(url) = request.image_data_url {
                content.push(json!({ "type": "input_image", "image_url": url }));
            }
            let mut body = json!({
                "model": OPENAI_MODEL,
                "instructions": instructions,
                "input": [{ "role": "user", "content": content }],
                "reasoning": { "effort": if request.question_mode { "low" } else { "none" } },
                "max_output_tokens": MAX_OUTPUT_TOKENS,
                "store": false,
            });
            if request.question_mode {
                body["tools"] = json!([{ "type": "web_search" }]);
            }
            body
        }
        Provider::Claude => {
            let mut content = Vec::new();
            if image.is_some_and(|(_, data)| data.len() > CLAUDE_IMAGE_MAX_BASE64) {
                return Err("画面画像が大きすぎるため、Claudeへ送れません。画面を小さくしてもう一度試してください。".into());
            }
            if let Some((mime, data)) = image {
                content.push(json!({
                    "type": "image",
                    "source": { "type": "base64", "media_type": mime, "data": data }
                }));
            }
            content.push(json!({ "type": "text", "text": request.prompt }));
            let mut body = json!({
                "model": ANTHROPIC_MODEL,
                "max_tokens": MAX_OUTPUT_TOKENS,
                "system": instructions,
                "thinking": { "type": "disabled" },
                "output_config": { "effort": "low" },
                "messages": [{ "role": "user", "content": content }],
            });
            if request.question_mode {
                body["tools"] =
                    json!([{ "type": "web_search_20250305", "name": "web_search", "max_uses": 3 }]);
            }
            body
        }
        Provider::Gemini => {
            let mut parts = Vec::new();
            if let Some((mime, data)) = image {
                parts.push(json!({ "inlineData": { "mimeType": mime, "data": data } }));
            }
            parts.push(json!({ "text": request.prompt }));
            let mut body = json!({
                "systemInstruction": { "parts": [{ "text": instructions }] },
                "contents": [{ "role": "user", "parts": parts }],
                "generationConfig": {
                    "maxOutputTokens": MAX_OUTPUT_TOKENS,
                    "thinkingConfig": { "thinkingLevel": "low" }
                },
            });
            if request.question_mode {
                body["tools"] = json!([{ "google_search": {} }]);
            }
            body
        }
    })
}

fn with_auth(
    provider: Provider,
    builder: reqwest::RequestBuilder,
    key: &str,
) -> reqwest::RequestBuilder {
    match provider {
        Provider::Codex => builder.bearer_auth(key),
        Provider::Claude => builder
            .header("x-api-key", key)
            .header("anthropic-version", ANTHROPIC_VERSION),
        Provider::Gemini => builder.header("x-goog-api-key", key),
    }
}

const TRUNCATED: &str = "回答が長すぎて途中で切れました。短く区切ってもう一度試してください。";

pub(crate) struct Reply {
    pub text: String,
    pub sources: Vec<String>,
    /// ClaudeのWeb検索が途中で区切られ、続きを要求する必要がある。
    pub paused: bool,
}

fn declined(label: &str) -> String {
    format!("{label}がこの内容への回答を控えました。")
}

fn unfinished(label: &str) -> String {
    format!("{label}の応答が完了しませんでした。もう一度試してください。")
}

fn strs<'a>(values: impl Iterator<Item = &'a Value>) -> Vec<String> {
    values
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

pub(crate) fn parse_reply(provider: Provider, body: &Value) -> Result<Reply, String> {
    let label = provider_label(provider);
    let empty = Vec::new();
    let array = |value: &'_ Value| value.as_array().unwrap_or(&empty).clone();
    match provider {
        Provider::Codex => {
            match body["status"].as_str() {
                Some("completed") => {}
                Some("incomplete") => return Err(TRUNCATED.into()),
                _ => return Err(unfinished(label)),
            }
            let parts: Vec<Value> = array(&body["output"])
                .into_iter()
                .filter(|item| item["type"] == "message")
                .flat_map(|item| array(&item["content"]))
                .filter(|part| part["type"] == "output_text")
                .collect();
            Ok(Reply {
                text: strs(parts.iter().map(|part| &part["text"])).concat(),
                sources: strs(
                    parts
                        .iter()
                        .flat_map(|part| array(&part["annotations"]))
                        .collect::<Vec<_>>()
                        .iter()
                        .map(|annotation| &annotation["url"]),
                ),
                paused: false,
            })
        }
        Provider::Claude => {
            let paused = match body["stop_reason"].as_str() {
                Some("end_turn" | "stop_sequence") => false,
                Some("pause_turn") => true,
                Some("refusal") => return Err(declined(label)),
                Some("max_tokens") => return Err(TRUNCATED.into()),
                _ => return Err(unfinished(label)),
            };
            let blocks: Vec<Value> = array(&body["content"])
                .into_iter()
                .filter(|block| block["type"] == "text")
                .collect();
            let citations: Vec<Value> = blocks
                .iter()
                .flat_map(|block| array(&block["citations"]))
                .collect();
            Ok(Reply {
                text: strs(blocks.iter().map(|block| &block["text"])).concat(),
                sources: strs(citations.iter().map(|citation| &citation["url"])),
                paused,
            })
        }
        Provider::Gemini => {
            if body["promptFeedback"]["blockReason"].is_string() {
                return Err(declined(label));
            }
            let candidate = &body["candidates"][0];
            match candidate["finishReason"].as_str() {
                Some("STOP") => {}
                Some("MAX_TOKENS") => return Err(TRUNCATED.into()),
                Some("SAFETY" | "PROHIBITED_CONTENT" | "BLOCKLIST" | "SPII" | "RECITATION") => {
                    return Err(declined(label))
                }
                _ => return Err(unfinished(label)),
            }
            let parts: Vec<Value> = array(&candidate["content"]["parts"])
                .into_iter()
                .filter(|part| part["thought"] != true)
                .collect();
            let chunks = array(&candidate["groundingMetadata"]["groundingChunks"]);
            Ok(Reply {
                text: strs(parts.iter().map(|part| &part["text"])).concat(),
                sources: strs(chunks.iter().map(|chunk| &chunk["web"]["uri"])),
                paused: false,
            })
        }
    }
}

/// Web検索で得た出典のURLを、本文にまだ無いものだけ重複なく末尾へ添える。
pub(crate) fn with_sources(text: String, sources: &[String]) -> String {
    let mut unique: Vec<&str> = Vec::new();
    for url in sources {
        let url = url.trim();
        if url.starts_with("https://") && !text.contains(url) && !unique.contains(&url) {
            unique.push(url);
        }
    }
    if unique.is_empty() {
        return text;
    }
    let list = unique
        .iter()
        .take(MAX_SOURCES)
        .map(|url| format!("- {url}"))
        .collect::<Vec<_>>()
        .join("\n");
    format!("{}\n\n出典:\n{list}", text.trim_end())
}

/// 応答本文はキーや入力を含むことがあるため、画面へはそのまま出さない。
pub(crate) fn status_error(provider: Provider, status: u16, body: &str) -> String {
    let label = provider_label(provider);
    let invalid_gemini_key = provider == Provider::Gemini
        && status == 400
        && (body.contains("API_KEY_INVALID") || body.contains("API key not valid"));
    let low_credit =
        provider == Provider::Claude && status == 400 && body.contains("credit balance");
    match status {
        401 => invalid_key_message(label),
        _ if invalid_gemini_key => invalid_key_message(label),
        403 => format!("{label}のAPIキーに、このモデルを使う権限がありません。各社の管理画面でキーの権限と利用できるモデルを確認してください。"),
        _ if low_credit => format!("{label}のAPIの残高が足りません。Anthropicの管理画面でクレジットを追加してください。"),
        429 => format!("{label}の利用上限に達したか、残高が足りません。各社の管理画面で利用状況を確認してください。"),
        404 => format!("{label}のモデルをこのAPIキーで使えません。キーの権限を確認してください。"),
        500..=599 => format!("{label}が一時的に応答できません。少し待ってからもう一度試してください。"),
        _ => format!("{label}で処理できませんでした（エラー{status}）。"),
    }
}

fn invalid_key_message(label: &str) -> String {
    format!("{label}のAPIキーが正しくないか、無効になっています。「接続と設定」でキーを入れ直してください。")
}

/// 各社のキーの形と違う場合だけ、確認に失敗した理由の手がかりを返す。
/// 形が将来変わっても保存を止めないよう、判定には使わない。
pub(crate) fn key_shape_hint(provider: Provider, key: &str) -> Option<String> {
    let (company, prefix) = match provider {
        Provider::Codex => ("OpenAI", "sk-"),
        Provider::Claude => ("Anthropic", "sk-ant-"),
        Provider::Gemini => ("Google", "AIza"),
    };
    if !key.starts_with(prefix) {
        return Some(format!("貼り付けた文字列は{company}のAPIキーの形（{prefix}…）ではありません。{company}の管理画面で発行したAPIキーを貼り付けてください。"));
    }
    if provider == Provider::Claude && key.chars().count() < 90 {
        return Some("キーが途中までしかコピーされていない可能性があります。Anthropicの管理画面で新しいキーを作り、表示されたキーを丸ごとコピーしてください。".into());
    }
    None
}

fn transport_error(provider: Provider, error: &reqwest::Error) -> String {
    let label = provider_label(provider);
    if error.is_timeout() {
        format!("{label}の応答が時間切れになりました。もう一度試してください。")
    } else {
        format!("{label}に接続できませんでした。インターネット接続を確認してください。")
    }
}

pub(crate) async fn generate(
    client: &reqwest::Client,
    provider: Provider,
    key: &str,
    request: &CloudRequest<'_>,
) -> Result<String, String> {
    let mut body = request_body(provider, request)?;
    let mut text = String::new();
    let mut sources = Vec::new();
    for _ in 0..=MAX_CONTINUATIONS {
        let response = with_auth(provider, client.post(request_url(provider)), key)
            .timeout(request_timeout(provider, request.question_mode))
            .json(&body)
            .send()
            .await
            .map_err(|error| transport_error(provider, &error))?;
        let status = response.status();
        let raw = response
            .text()
            .await
            .map_err(|error| transport_error(provider, &error))?;
        if !status.is_success() {
            return Err(status_error(provider, status.as_u16(), &raw));
        }
        let value: Value = serde_json::from_str(&raw)
            .map_err(|_| format!("{}の応答を読めませんでした。", provider_label(provider)))?;
        let reply = parse_reply(provider, &value)?;
        text.push_str(&reply.text);
        sources.extend(reply.sources);
        if !reply.paused {
            return Ok(with_sources(text, &sources));
        }
        // Claudeが検索の途中で区切った場合は、受け取った内容を変えずに続きを求める。
        if let Some(messages) = body["messages"].as_array_mut() {
            messages.push(json!({ "role": "assistant", "content": value["content"].clone() }));
        }
    }
    Err(unfinished(provider_label(provider)))
}

/// 保存前にモデル情報を取得し、キーが使えることを確かめる。文章は送らない。
pub(crate) async fn verify_key(
    client: &reqwest::Client,
    provider: Provider,
    key: &str,
) -> Result<(), String> {
    let response = with_auth(provider, client.get(model_url(provider)), key)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|error| transport_error(provider, &error))?;
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let text = response.text().await.unwrap_or_default();
    let code = status.as_u16();
    let invalid = code == 401 || (provider == Provider::Gemini && code == 400);
    let hint = invalid.then(|| key_shape_hint(provider, key)).flatten();
    Err(match hint {
        Some(hint) => format!("{}がこのキーを受け付けませんでした。{hint}", provider_label(provider)),
        None if invalid => format!("{}がこのキーを受け付けませんでした。キーが削除・無効化されていないか、管理画面で確認してください。", provider_label(provider)),
        None => status_error(provider, code, &text),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const IMAGE: &str = "data:image/jpeg;base64,QUJD";

    fn reply_text(provider: Provider, body: &Value) -> Result<String, String> {
        parse_reply(provider, body).map(|reply| with_sources(reply.text, &reply.sources))
    }

    fn request(question_mode: bool, image: Option<&'static str>) -> CloudRequest<'static> {
        CloudRequest {
            prompt: "入力",
            question_mode,
            image_data_url: image,
        }
    }

    #[test]
    fn 文章整形は検索を付けず各社の速いモデルへ送る() {
        let openai = request_body(Provider::Codex, &request(false, None)).unwrap();
        assert_eq!(openai["model"], OPENAI_MODEL);
        assert_eq!(openai["reasoning"]["effort"], "none");
        assert_eq!(openai["store"], false);
        assert!(openai.get("tools").is_none());

        let claude = request_body(Provider::Claude, &request(false, None)).unwrap();
        assert_eq!(claude["model"], ANTHROPIC_MODEL);
        assert_eq!(claude["thinking"]["type"], "disabled");
        assert!(claude.get("tools").is_none());

        let gemini = request_body(Provider::Gemini, &request(false, None)).unwrap();
        assert_eq!(
            gemini["generationConfig"]["thinkingConfig"]["thinkingLevel"],
            "low"
        );
        assert!(gemini.get("tools").is_none());
        assert!(request_url(Provider::Gemini).contains(GEMINI_MODEL));
    }

    #[test]
    fn 質問のときだけweb検索と画面画像を付ける() {
        let openai = request_body(Provider::Codex, &request(true, Some(IMAGE))).unwrap();
        assert_eq!(openai["tools"][0]["type"], "web_search");
        assert_eq!(openai["input"][0]["content"][1]["image_url"], IMAGE);

        let claude = request_body(Provider::Claude, &request(true, Some(IMAGE))).unwrap();
        assert_eq!(claude["tools"][0]["type"], "web_search_20250305");
        assert_eq!(
            claude["messages"][0]["content"][0]["source"]["media_type"],
            "image/jpeg"
        );
        assert_eq!(
            claude["messages"][0]["content"][0]["source"]["data"],
            "QUJD"
        );

        let gemini = request_body(Provider::Gemini, &request(true, Some(IMAGE))).unwrap();
        assert!(gemini["tools"][0].get("google_search").is_some());
        assert_eq!(
            gemini["contents"][0]["parts"][0]["inlineData"]["data"],
            "QUJD"
        );
    }

    #[test]
    fn 画像以外のデータは送らない() {
        let bad = request(true, Some("data:text/plain;base64,QUJD"));
        assert!(request_body(Provider::Claude, &bad).is_err());
        assert!(request_body(Provider::Gemini, &request(true, Some("QUJD"))).is_err());
    }

    #[test]
    fn 各社の応答から本文だけを取り出す() {
        let openai = json!({"status":"completed","output":[
            {"type":"reasoning","summary":[]},
            {"type":"web_search_call"},
            {"type":"message","content":[{"type":"output_text","text":"本文"},{"type":"output_text","text":"続き"}]}
        ]});
        assert_eq!(reply_text(Provider::Codex, &openai).unwrap(), "本文続き");

        let claude = json!({"stop_reason":"end_turn","content":[
            {"type":"server_tool_use"},{"type":"web_search_tool_result"},{"type":"text","text":"回答"}
        ]});
        assert_eq!(reply_text(Provider::Claude, &claude).unwrap(), "回答");

        let gemini = json!({"candidates":[{"finishReason":"STOP","content":{"parts":[
            {"text":"考え中","thought":true},{"text":"答え"}
        ]}}]});
        assert_eq!(reply_text(Provider::Gemini, &gemini).unwrap(), "答え");
    }

    #[test]
    fn web検索の出典urlを重複なく末尾へ添える() {
        let openai = json!({"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"答え",
            "annotations":[{"type":"url_citation","url":"https://a.example/1"},{"type":"url_citation","url":"https://a.example/1"}]}]}]});
        assert_eq!(
            reply_text(Provider::Codex, &openai).unwrap(),
            "答え\n\n出典:\n- https://a.example/1"
        );

        let claude = json!({"stop_reason":"end_turn","content":[{"type":"text","text":"答え","citations":[{"url":"https://b.example/"}]}]});
        assert!(reply_text(Provider::Claude, &claude)
            .unwrap()
            .ends_with("- https://b.example/"));

        let gemini = json!({"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":"答え https://c.example/"}]},
            "groundingMetadata":{"groundingChunks":[{"web":{"uri":"https://c.example/"}},{"web":{"uri":"http://insecure.example/"}}]}}]});
        assert_eq!(
            reply_text(Provider::Gemini, &gemini).unwrap(),
            "答え https://c.example/"
        );
    }

    #[test]
    fn 完了していない応答は成功として扱わない() {
        let paused = json!({"stop_reason":"pause_turn","content":[{"type":"text","text":"途中"}]});
        let reply = parse_reply(Provider::Claude, &paused).unwrap();
        assert!(reply.paused);
        assert!(parse_reply(
            Provider::Claude,
            &json!({"stop_reason":"unknown","content":[]})
        )
        .is_err());
        assert!(parse_reply(
            Provider::Codex,
            &json!({"status":"in_progress","output":[]})
        )
        .is_err());
        assert!(parse_reply(
            Provider::Gemini,
            &json!({"candidates":[{"finishReason":"OTHER","content":{"parts":[{"text":"途"}]}}]})
        )
        .is_err());
        assert!(parse_reply(
            Provider::Gemini,
            &json!({"candidates":[{"content":{"parts":[{"text":"途"}]}}]})
        )
        .is_err());
    }

    #[test]
    fn claudeの上限を超える画面画像は送らない() {
        let large = format!(
            "data:image/jpeg;base64,{}",
            "A".repeat(CLAUDE_IMAGE_MAX_BASE64 + 1)
        );
        let request = CloudRequest {
            prompt: "質問",
            question_mode: true,
            image_data_url: Some(&large),
        };
        assert!(request_body(Provider::Claude, &request)
            .unwrap_err()
            .contains("大きすぎる"));
        assert!(request_body(Provider::Codex, &request).is_ok());
    }

    #[test]
    fn 途中で切れた応答や回答拒否は本文として使わない() {
        assert!(reply_text(Provider::Codex, &json!({"status":"incomplete","output":[]})).is_err());
        assert!(reply_text(
            Provider::Claude,
            &json!({"stop_reason":"max_tokens","content":[{"type":"text","text":"途"}]})
        )
        .is_err());
        assert!(reply_text(
            Provider::Claude,
            &json!({"stop_reason":"refusal","content":[]})
        )
        .is_err());
        assert!(reply_text(Provider::Gemini, &json!({"candidates":[{"finishReason":"MAX_TOKENS","content":{"parts":[{"text":"途"}]}}]})).is_err());
        assert!(reply_text(
            Provider::Gemini,
            &json!({"promptFeedback":{"blockReason":"SAFETY"}})
        )
        .is_err());
    }

    #[test]
    fn 失敗の理由を利用者向けに伝え応答本文は出さない() {
        assert!(status_error(Provider::Codex, 401, "sk-secret").contains("APIキーが正しくない"));
        assert!(!status_error(Provider::Codex, 401, "sk-secret").contains("sk-secret"));
        assert!(status_error(Provider::Gemini, 400, "API key not valid")
            .contains("APIキーが正しくない"));
        assert!(status_error(Provider::Claude, 429, "").contains("利用上限"));
        assert!(status_error(Provider::Claude, 529, "").contains("一時的"));
        assert!(status_error(Provider::Gemini, 400, "other").contains("エラー400"));
    }

    // 実際の各社APIで確かめる。キーは環境変数で渡し、通常のテストでは動かさない。
    // DOON_VOICE_LIVE_PROVIDER=claude DOON_VOICE_LIVE_KEY=... cargo test 実api -- --ignored
    #[test]
    #[ignore]
    fn 実apiでキー確認と整形と画面質問ができる() {
        let provider = match std::env::var("DOON_VOICE_LIVE_PROVIDER").as_deref() {
            Ok("codex") => Provider::Codex,
            Ok("gemini") => Provider::Gemini,
            _ => Provider::Claude,
        };
        let key = std::env::var("DOON_VOICE_LIVE_KEY").expect("DOON_VOICE_LIVE_KEY");
        tauri::async_runtime::block_on(async {
            let client = http_client().unwrap();
            verify_key(&client, provider, &key).await.unwrap();
            if provider == Provider::Claude {
                let truncated: String = key.chars().take(53).collect();
                let message = verify_key(&client, provider, &truncated).await.unwrap_err();
                println!("途中までのキー: {message}");
                assert!(message.contains("途中まで"));
            }
            assert!(verify_key(&client, provider, "invalid-key")
                .await
                .unwrap_err()
                .contains("キー"));
            let prompt = "次の音声文字起こしを、話し手の口調を保ったまま句読点を入れて整える。本文だけを返す。\n\n入力: えっとさあ明日の打ち合わせなんだけど資料まだできてないからちょっと遅らせてもらえるかな\n出力:";
            let text = generate(
                &client,
                provider,
                &key,
                &CloudRequest {
                    prompt,
                    question_mode: false,
                    image_data_url: None,
                },
            )
            .await
            .unwrap();
            println!("整形: {text}");
            assert!(text.contains("打ち合わせ"));
            // アプリと同じJPEGの画面画像を DOON_VOICE_LIVE_IMAGE で渡す。
            use base64::Engine as _;
            let bytes = std::fs::read(
                std::env::var("DOON_VOICE_LIVE_IMAGE").expect("DOON_VOICE_LIVE_IMAGE"),
            )
            .unwrap();
            let image = format!(
                "data:image/jpeg;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            );
            let image = image.as_str();
            let answer = generate(
                &client,
                provider,
                &key,
                &CloudRequest {
                    prompt: "この画面に表示されているアプリの設定項目を3つ挙げてください。",
                    question_mode: true,
                    image_data_url: Some(image),
                },
            )
            .await
            .unwrap();
            println!("画面質問: {answer}");
            assert!(!answer.trim().is_empty());
            let searched = generate(
                &client,
                provider,
                &key,
                &CloudRequest {
                    prompt: "Anthropicの公式サイトのURLを、Webで調べて一言で答えてください。",
                    question_mode: true,
                    image_data_url: None,
                },
            )
            .await
            .unwrap();
            println!("検索質問: {searched}");
            assert!(searched.contains("https://"));
        });
    }

    #[test]
    fn キーの形が違う時は理由の手がかりを出す() {
        assert!(key_shape_hint(Provider::Claude, "sk-proj-abc")
            .unwrap()
            .contains("sk-ant-"));
        assert!(key_shape_hint(
            Provider::Claude,
            &format!("sk-ant-api03-{}", "a".repeat(30))
        )
        .unwrap()
        .contains("途中まで"));
        assert!(key_shape_hint(
            Provider::Claude,
            &format!("sk-ant-api03-{}", "a".repeat(95))
        )
        .is_none());
        assert!(key_shape_hint(Provider::Gemini, "sk-abc")
            .unwrap()
            .contains("AIza"));
        assert!(key_shape_hint(Provider::Codex, "sk-proj-abc").is_none());
        assert!(status_error(Provider::Claude, 403, "").contains("権限"));
        assert!(
            status_error(Provider::Claude, 400, "Your credit balance is too low").contains("残高")
        );
    }

    #[test]
    fn 貼り付けたキーの前後の空白だけを除く() {
        assert_eq!(normalize_key("  sk-abc\n").unwrap(), "sk-abc");
        assert!(normalize_key("   ").is_err());
        assert!(normalize_key("sk-a bc").is_err());
        assert!(normalize_key(&"a".repeat(API_KEY_MAX_CHARS + 1)).is_err());
    }
}
