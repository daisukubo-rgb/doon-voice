# DOON Voice 0.5.18 音声取得エラーの修正

確認日: 2026-09-15。主担当: 石川。協働: 長谷川（音声判定）、村上（署名調査・Intelエンジン）、西田（独立レビュー）。

## 現象と根拠

0.5.17の実画面で「音声が検出されませんでした」を確認。MacBook Airの内蔵マイクが既定、48kHz、入力音量は画面上約75%。マイク許可はDOON Voiceの2項目ともオンで、CoreAudioに録音開始・停止の記録があった。ユーザーの録音波形は保存されないため、その回の音量と無音判定の理由は後から確定できない。

### 1. マイク利用の署名宣言が欠落（実機で拒否を確認）

修正途中の0.5.18を実マイクで試験しても無音となり、macOSのtccdログで `kTCCServiceMicrophone requires entitlement com.apple.security.device.audio-input but it is missing` と明示された。設定画面の許可表示やCoreAudioの開始記録だけでは、実際の録音許可を保証できない。

`src-tauri/Entitlements.plist`にマイク利用を宣言し、Tauriの配布署名へ指定した。設定ファイルだけでなく、最終DMG内の親アプリ署名からXMLを抽出・解析し、該当値が真であることを検査する。未設定の配布物で失敗、追加後の最終DMGで成功した。

更新でad-hoc署名の識別情報が変わるため、既存許可との不一致とmacOSの再許可待ちを確認した。OSの許可ダイアログは操作ツールの安全制限対象で、エージェントは許可操作を行っていない。

### 2. 有音データを無音として拒否

Whisper前の独自判定は大きな固定音量を要求し、発話自体を背景音と推定する場合もあった。同一の合成波形で次を再現した。

- 最大振幅0.018は拒否、0.040は通過。
- 最大振幅0.033で無音なしは拒否、先頭に300msの無音を足すと通過。
- 日本語合成音声は通常音量で通過、小音量（最大振幅0.015）で拒否。
- 1msの大きなクリックは誤通過。

修正後は実サンプルレートで継続時間を数え、量子化程度の信号・完全無音・短い単発音だけを除く。振幅で発話の意味を保証するものではなく、認識はWhisperが行う。録音を捨てる条件を保守的にしたため、持続する環境音は認識へ進むことがある。

### 3. 配布署名後のエンジン起動失敗

インストール済み0.5.17のwhisper-cliを、アプリと同じライブラリ指定で起動するとSIGABRTになった。原因はHardened Runtimeのライブラリ検証と、ad-hoc署名された同梱dylibのTeam ID不整合。署名のdeep/strict検査だけでは検出できなかった。

WhisperとGGML、Metalシェーダーを実行ファイルへ組み込み、OS標準ライブラリだけを動的参照する方式へ変更した。Hardened Runtimeやライブラリ検証を無効化する設定は加えていない。配布テストは署名後のエンジンを実際に起動し、DMG内でも同じ確認を行う。

## エンジンの再ビルド条件

公式whisper.cpp v1.9.2を使用。

- ソース: `https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v1.9.2.tar.gz`
- アーカイブSHA-256: `a6abd064fcca8b85e794d205abf328c522e9451db43a3eadc178b883b7d0e9cd`
- Release、macOS最小12.0、ビルド対象`whisper-cli`。
- `BUILD_SHARED_LIBS=OFF`、`GGML_BACKEND_DL=OFF`、`GGML_STATIC=OFF`。
- `GGML_NATIVE=OFF`、`GGML_OPENMP=OFF`。
- `GGML_METAL=ON`、`GGML_METAL_EMBED_LIBRARY=ON`。
- `GGML_BLAS=ON`、`GGML_BLAS_VENDOR=Apple`。
- `WHISPER_BUILD_TESTS=OFF`、`WHISPER_BUILD_SERVER=OFF`。
- Intel版はAVX/AVX2/FMA/F16C/BMI2/AVX512系/AVX_VNNIを無効化し、ビルド端末固有の命令を要求しない。

対象別の来歴とバイナリハッシュは`src-tauri/resources/engine/macos-build.json`に記録する。過去の同梱dylibは今回の静的エンジンでは参照しない。

## 検証

- 修正前の失敗をテストへ追加し、RED・GREENのコミットを分けて保存。
- 音量5段階、録音レート8/16/44.1/48/96kHz、無音長、量子化相当、1〜40msクリックを確認。
- Kyokoによる日本語合成音声を通常・小音量・さらに小音量の3段階へ調整し、無音除外の通過を確認。
- 修正版の署名済みエンジン＋端末内large-v3-turboモデルで小音量音声を認識し、「明日の会議は10時からです。音声入力の確認をしています。」を取得。
- Rust全体96件成功、実CLI／クラウド通信の2件は未実行。
- Clippy（警告をエラー扱い）・Rust整形・TypeScript/Viteビルド成功。
- Nodeの既存2件と配布14件が成功。ダブルクリック起動用のシェル検査成功。
- 最終DMG内で署名、マイク利用宣言、エンジン起動、381件のライセンス原文・ハッシュ検査が成功。
- IntelエンジンもHardened Runtime付き一時署名後、Rosetta経由の`--help`起動に成功。Intel Mac実機での録音試験ではない。
- 西田によるJavaScript・配布設定の独立レビューで重大指摘なし。

最終配布物・実機操作の状態は末尾に記録する。

## 検証範囲の注意

合成音声の試験は、ユーザーがその場で話した音声の再現ではない。クラウドAIへの本文送信は行わない。Windows／Intel Mac実機、前版からのMSVC DLL・VCOMP140・sigchldの確認事項は今回の検証範囲外。

## 最終配布物と端末状態

- `/Applications/DOON Voice.app`をマイク宣言を含む0.5.18へ更新済み。旧0.5.17は`/Applications/DOON Voice-0.5.17-backup-20260915.app`へ保存。
- インストールされた最終エンジンで`quiet.wav`を認識し、終了コード0、日本語本文「明日の会議は10時からです。音声入力の確認をしています。」を取得。
- 実マイク試験はOSの再許可待ち。`AUTHREQ_PROMPTING`ログを確認し、ユーザーへ許可操作を依頼。許可ダイアログはツールの安全制限により操作していない。マイク準備の5秒期限は待ち続けずエラーになるため、許可後は録音開始を再操作する。
- ユーザーの実発話、外部AI、他アプリへの入力成功は未確認。

| 成果物 | SHA-256 |
|---|---|
| `src-tauri/target/release/bundle/dmg/DOON Voice_0.5.18_aarch64.dmg` | `879d640d65af735ae206092868abd969582f04913da64a53d04f2586e30eb0af` |
| `dist/DOON Voice-macOS.zip` | `979d21079b0403233e49148910e50f2d5d6f2b7f722592a9a5334b7bcc46c728` |

再現ログと試験用の合成音声は`/tmp/doon-voice-input-20260915/`に保存。GitHub Releaseの公開更新は行っていない。
