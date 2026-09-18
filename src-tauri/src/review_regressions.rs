use super::*;

#[test]
fn recognized_original_preserves_names_fillers_and_literal_tags() {
    for text in [
        "あーちゃんに連絡してください。",
        "あーだこうだ言わないでください。",
        "えーと、明日の会議です。",
        "終了タグは</think>で、その前の文章も保持します。",
        "<think>引用したタグです</think>",
    ] {
        let recognized = finish_whisper_text(text, None).unwrap();
        assert_eq!(recognized.text, text, "original must stay recoverable");
        assert_eq!(
            clean(&recognized.text).unwrap(),
            text,
            "raw output must match original"
        );
        let mut runtime = BackgroundVoiceRuntime::new(VoiceRuntimeConfig::default());
        runtime.transcript = recognized.text;
        runtime.recovery_pending = true;
        assert_eq!(runtime.snapshot().transcript, text);
        runtime.acknowledge_result();
        assert_eq!(runtime.snapshot().transcript, text);
    }
}

#[test]
fn active_recording_rejects_changed_settings_without_losing_confirmed_configuration() {
    for phase in [
        BackgroundVoicePhase::Starting,
        BackgroundVoicePhase::Recording,
        BackgroundVoicePhase::Processing,
    ] {
        let mut runtime = BackgroundVoiceRuntime::new(VoiceRuntimeConfig::default());
        runtime.configuration_ready = true;
        runtime.phase = phase;
        assert!(runtime
            .configure(OutputTarget::Raw, vec![], |_| panic!(
                "must not save during a recording"
            ))
            .is_err());
        assert!(runtime
            .configure(OutputTarget::Codex, vec!["新しい語".into()], |_| panic!(
                "must not change active dictionary"
            ))
            .is_err());
        assert_eq!(runtime.config.target, OutputTarget::Codex);
        assert!(runtime.config.dictionary.is_empty());
        assert!(runtime.configuration_ready);
        assert!(!runtime
            .configure(OutputTarget::Codex, vec![], |_| panic!(
                "identical settings need no write"
            ))
            .unwrap());
    }
}

#[test]
fn idle_settings_are_committed_only_after_successful_persistence() {
    let mut runtime = BackgroundVoiceRuntime::new(VoiceRuntimeConfig::default());
    runtime.configuration_ready = true;
    assert!(runtime
        .configure(OutputTarget::Raw, vec![], |_| Err("disk full".into()))
        .is_err());
    assert_eq!(runtime.config.target, OutputTarget::Codex);
    assert!(!runtime.configuration_ready);
    assert!(runtime
        .configure(OutputTarget::Raw, vec!["DOON".into()], |config| {
            assert_eq!(config.target, OutputTarget::Raw);
            assert_eq!(config.dictionary, vec!["DOON"]);
            Ok(())
        })
        .unwrap());
    assert_eq!(runtime.config.target, OutputTarget::Raw);
    assert!(runtime.configuration_ready);
}

#[test]
fn exiting_keeps_active_recordings_but_never_requires_discarding_text() {
    let mut runtime = BackgroundVoiceRuntime::new(VoiceRuntimeConfig::default());
    assert!(runtime.exit_block_reason().is_none());
    for phase in [
        BackgroundVoicePhase::Starting,
        BackgroundVoicePhase::Recording,
        BackgroundVoicePhase::Processing,
    ] {
        runtime.phase = phase;
        assert!(runtime.exit_block_reason().is_some());
    }
    runtime.phase = BackgroundVoicePhase::Idle;
    runtime.transcript = "回収する原文".into();
    runtime.recovery_pending = true;
    assert!(runtime.exit_block_reason().is_none());
}

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
        assert_eq!(normalize_transcription(text).unwrap(), text);
    }
}

#[test]
fn punctuation_only_edits_are_still_accepted() {
    assert_eq!(
        preserve_transcription_meaning("明日は会議です", "明日は会議です。"),
        "明日は会議です。"
    );
}

#[test]
fn dictionary_rejects_overflow_without_silently_dropping_terms() {
    assert!(validate_dictionary(vec!["a".repeat(81)]).is_err());
    assert!(validate_dictionary(vec!["a".into(); 101]).is_err());
    assert_eq!(
        validate_dictionary(vec![" DOON ".into()]).unwrap(),
        vec!["DOON"]
    );
    assert!(validate_dictionary(vec!["𠮷".repeat(80)]).is_ok());
}

#[test]
fn recovery_does_not_block_the_next_recording() {
    let mut runtime = BackgroundVoiceRuntime::new(VoiceRuntimeConfig::default());
    runtime.configuration_ready = true;
    runtime.transcript = "残す原文".into();
    runtime.recovery_pending = true;
    assert!(runtime.ensure_can_record().is_ok());
    assert_eq!(runtime.transcript, "残す原文");
    assert!(!runtime.clipboard_saved);
}

#[test]
fn raw_mode_does_not_require_any_ai_provider() {
    let target: OutputTarget = serde_json::from_str("\"raw\"").unwrap();
    assert!(matches!(target, OutputTarget::Raw));
}

#[test]
fn stale_or_busy_result_actions_cannot_acknowledge_a_new_result() {
    let mut runtime = BackgroundVoiceRuntime::new(VoiceRuntimeConfig::default());
    runtime.generation = 2;
    runtime.recovery_pending = true;
    assert!(validate_result_action(&runtime, 1).is_err());
    for phase in [
        BackgroundVoicePhase::Starting,
        BackgroundVoicePhase::Recording,
        BackgroundVoicePhase::Processing,
    ] {
        runtime.phase = phase;
        assert!(validate_result_action(&runtime, 2).is_err());
    }
    runtime.phase = BackgroundVoicePhase::Idle;
    assert!(validate_result_action(&runtime, 2).is_ok());
    assert!(runtime.recovery_pending);
}

#[test]
fn whisper_failure_retains_partial_text_but_never_looks_successful() {
    let result =
        finish_whisper_text("明日の会議は10時です", Some("処理が中断されました".into())).unwrap();
    assert_eq!(result.text, "明日の会議は10時です");
    assert!(result.warning.is_some());
    assert!(finish_whisper_text("", Some("処理が中断されました".into())).is_err());
}

#[test]
fn unconfirmed_settings_block_shortcut_recording_and_retry() {
    let mut runtime = BackgroundVoiceRuntime::new(VoiceRuntimeConfig::default());
    assert!(
        !runtime.configuration_ready,
        "startup must wait for validated UI settings"
    );
    runtime.configuration_ready = false;
    assert!(runtime.ensure_can_record().is_err());
    runtime.configuration_ready = true;
    assert!(runtime.ensure_can_record().is_ok());
}

#[test]
fn partial_recordings_require_manual_review_even_after_retry() {
    let mut runtime = BackgroundVoiceRuntime::new(VoiceRuntimeConfig::default());
    runtime.delivery_warning = Some("マイクが切断されました".into());
    runtime.transcript = "途中までの原文".into();
    runtime.output = "途中までの原文。".into();
    assert!(runtime.ensure_auto_delivery().is_err());
    runtime.generation += 1;
    assert!(runtime.ensure_auto_delivery().is_err());
    runtime.delivery_warning = None;
    assert!(runtime.ensure_auto_delivery().is_ok());
}

#[test]
fn failed_engine_shutdown_preserves_partial_text_and_blocks_more_recording() {
    let result = failed_whisper_shutdown("残っている原文", "停止失敗");
    assert_eq!(result.text, "残っている原文");
    assert!(result.restart_required);
    let mut runtime = BackgroundVoiceRuntime::new(VoiceRuntimeConfig::default());
    runtime.configuration_ready = true;
    runtime.engine_restart_required = result.restart_required;
    assert!(runtime.ensure_can_record().is_err());
}
