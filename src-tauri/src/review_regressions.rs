use super::*;

#[test]
fn meaning_guard_preserves_negation_signs_urls_and_complete_sentences() {
    for (input, output) in [
        ("明日の会議はキャンセルしないでください。", "明日の会議はキャンセルしてください。"),
        ("差額は-100円です。", "差額は+100円です。"),
        ("リンクはhttps://example.com/aです。", "リンクはhttps://example.com/bです。"),
        ("明日の会議は十時から始めます。資料を持ってきてください。遅れる場合は連絡してください。", "明日の会議は十時から始めます。資料を持ってきてください。"),
        ("単価は1.25円です。", "単価は125円です。"),
        ("来週は大阪へ行きます。", "来週は東京へ行きます。"),
    ] {
        assert_eq!(preserve_transcription_meaning(input, output), input, "unsafe change: {output}");
    }
}

#[test]
fn normal_business_dictation_is_not_discarded_for_repetition() {
    for text in [
        "明日の会議は10時です。明日の会議に資料を持ってきてください。",
        "株式会社DOONです。株式会社DOONの長谷川です。",
        "ありがとうございました。",
    ] {
        assert!(!is_probable_whisper_hallucination(text), "valid dictation: {text}");
    }
}

#[test]
fn punctuation_only_edits_are_still_accepted() {
    assert_eq!(preserve_transcription_meaning("明日は会議です", "明日は会議です。"), "明日は会議です。");
}

#[test]
fn dictionary_rejects_overflow_without_silently_dropping_terms() {
    assert!(validate_dictionary(vec!["a".repeat(81)]).is_err());
    assert!(validate_dictionary(vec!["a".into(); 101]).is_err());
    assert_eq!(validate_dictionary(vec![" DOON ".into()]).unwrap(), vec!["DOON"]);
    assert!(validate_dictionary(vec!["𠮷".repeat(80)]).is_ok());
}

#[test]
fn recovery_requires_acknowledgment_before_new_recording() {
    let mut runtime = BackgroundVoiceRuntime::new(VoiceRuntimeConfig::default());
    runtime.transcript = "残す原文".into();
    runtime.recovery_pending = true;
    assert!(runtime.ensure_can_record().is_err());
    runtime.acknowledge_result();
    assert!(runtime.ensure_can_record().is_ok());
    assert_eq!(runtime.transcript, "残す原文");
    assert!(runtime.clipboard_saved);
}

#[test]
fn raw_mode_does_not_require_any_ai_provider() {
    let target: OutputTarget = serde_json::from_str("\"raw\"").unwrap();
    assert!(matches!(target, OutputTarget::Raw));
}
