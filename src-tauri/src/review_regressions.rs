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
