# DOON Voice 0.5.19 Windowsテスト配布

確認日: 2026-09-16。主担当: 石川。協働: 村上（Windowsエンジン・独立レビュー）、長谷川（Windowsプロセス起動）、西田（配布検査・独立レビュー）。

## 変更

- 公式whisper.cpp v1.9.2を固定ソースからWindows x64向けにビルド。MSVCランタイムを静的に組み込み、OpenMP・AVX系を無効化した。単独エンジンの参照DLLはOS標準のADVAPI32.dllとKERNEL32.dllのみ。
- 旧Whisper／GGML／SDL2／MSVC DLL 23ファイルを削除。来歴、ビルド設定、バイナリSHA-256を`src-tauri/resources/engine/windows-build.json`に保存。
- Windowsのnpm版AI CLIを実体のNodeスクリプトまたはEXEへ解決。標準npm形式だけを扱い、本文は引き続きJSONの標準入力で渡す。通常処理のコンソール表示を抑え、明示したログインだけ専用コンソールを開く。
- ライセンス収集でlucideのcopyrightアイコンやRustのcopyingソースを誤収集していた条件を修正。ライセンス原文の名前を維持し、一覧の全ファイルを配布へ同梱する。
- Windows上で品質検査・MSI生成・MSI展開後のエンジンとアプリ起動検査を行い、手順付きZIPを作る専用CIを追加。

## 試験データ

本番と同じ`ggml-large-v3-turbo-q5_0.bin`（574,041,195 bytes）とwhisper.cpp v1.9.2の`jfk.wav`を固定URLから取得し、認識前にSHA-256を照合する。外部AIへの本文送信は行わない。

| 対象 | SHA-256 |
|---|---|
| モデル | `394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2` |
| 音声 | `59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e` |
| Windowsエンジン | `b22658171484743ddfe3e0d32458995e64cb15e9b7fdb45610877897d381a141` |

## 検証中

最終CI結果と配布物のハッシュは完了時に追記する。

## 検証の限界

Windows CIはMicrosoftのWindows Server 2022 x64 runnerを使用する。Windows 10/11の物理PC、実マイク、利用者の入力先への貼り付け、実アカウントでの外部AI認証・通信は未確認。npmラッパーがさらに生成する子プロセスの画面挙動も全CLIでは確認していない。

配布物にコード署名証明書は付けていない。組織の端末制限やWindowsの起動警告は残り得る。一般公開Releaseは更新せず、テスト用artifactとローカルZIPを提供する。既存Mac配布0.5.18は保持する。
