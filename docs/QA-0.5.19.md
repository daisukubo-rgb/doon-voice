# DOON Voice 0.5.19 Windowsテスト配布

確認日: 2026-09-16。主担当: 石川。協働: 村上（Windowsエンジン・独立レビュー）、長谷川（Windowsプロセス起動）、西田（配布検査・独立レビュー）。

## 変更

- 公式whisper.cpp v1.9.2を固定ソースからWindows x64向けにビルド。MSVCランタイムを静的に組み込み、OpenMPを無効化した。互換版とAVX2版を同梱し、CPUのSSE4.2／AVX／AVX2／FMA／F16Cを検出して選択する。両エンジンの参照DLLはOS標準のADVAPI32.dllとKERNEL32.dllのみ。
- 旧Whisper／GGML／SDL2／MSVC DLL 23ファイルを削除。来歴、ビルド設定、バイナリSHA-256を`src-tauri/resources/engine/windows-build.json`と`windows-avx2-build.json`に保存。
- Windowsのnpm版AI CLIを実体のNodeスクリプトまたはEXEへ解決。標準npm形式だけを扱い、本文は引き続きJSONの標準入力で渡す。通常処理のコンソール表示を抑え、明示したログインだけ専用コンソールを開く。
- ライセンス収集でlucideのcopyrightアイコンやRustのcopyingソースを誤収集していた条件を修正。ライセンス原文の名前を維持し、一覧の全ファイルを配布へ同梱する。
- Windows上で品質検査・MSI生成・展開後のエンジンとアプリ起動検査に加え、実インストール・起動・アンインストールを行い、手順付きZIPを作る専用CIを追加。

## 試験データ

本番と同じ`ggml-large-v3-turbo-q5_0.bin`（574,041,195 bytes）とwhisper.cpp v1.9.2の`jfk.wav`を固定URLから取得し、認識前にSHA-256を照合する。外部AIへの本文送信は行わない。

| 対象 | SHA-256 |
|---|---|
| モデル | `394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2` |
| 音声 | `59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e` |
| Windowsエンジン | `b22658171484743ddfe3e0d32458995e64cb15e9b7fdb45610877897d381a141` |
| Windows AVX2エンジン | `d1159b3bb1f5a98e18ae38f866aba9f8045c82d03aac6044e67decaa792977e3` |

## 性能による設計変更

互換版の単独起動は成功したが、4 CPUのWindows runnerで上記11秒音声の認識が120秒を超えた。製品と同じデコード設定（`-mc 0 -nth 0.9 -nf -sns`）と300秒上限でもタイムアウトした。診断出力ではCPU SIMD機能が有効になっていなかった。

固定AVX2版への全面置換では対応しないCPUが実行不能になるため、追加の単独EXEを同梱してCPU機能で選ぶ方式とした。互換版の起動・依存検査と、対応CPUでのAVX2版の実認識を分けて検査する。互換版の実モデル認識は今回成功しておらず、古いCPUでは5分上限にかかり得る。

## 最終検証

### 2026-09-17 実インストール検査

[Windows配布CI 35186294808](https://github.com/daisukubo-rgb/doon-voice/actions/runs/35186294808)が成功した。`4deff2df3f3b1dca9361ec6562990c0b4c0bc492`で、Windows Server 2022 x64 runner上のMSIを`C:\Program Files\DOON Voice`へ通常インストールし、実EXEのウィンドウ表示を確認した。その後、MSIでアンインストールし、アプリ本体の残存がないことを確認した。

[Windows配布CI 35055622325](https://github.com/daisukubo-rgb/doon-voice/actions/runs/35055622325)は2026-09-16 13:38 JSTに成功した。ビルド対象は`feat/windows-test-20260916`の`5fdfe2d37d00070880c53cc3cd249ff939ef9e93`。

| 検査 | 結果 |
|---|---|
| Rust全対象 | 110成功、0失敗、既存2件除外（実CLI・外部AI通信） |
| Node | 基本2件成功、配布13件成功・Mac専用3件除外。起動ランチャー検査も成功 |
| UI回帰 | Playwright 38項目成功 |
| 型・画面ビルド・Rust整形・Clippy | 全成功、Clippyは警告をエラーとして検査 |
| 単独Windowsエンジン | 両EXEのSHA・起動成功。AVX2版は11秒音声を37.917秒で認識 |
| MSI生成・展開 | `DOON Voice_0.5.19_x64_en-US.msi`生成、管理者用展開による内容検査成功。2026-09-17に通常インストール・起動・アンインストールも成功 |
| MSI内エンジン | 両EXEのSHA・起動成功。AVX2版は同じ音声を38.547秒で認識 |
| MSI内アプリ | 追加VCランタイムの直接依存なし。実EXEが起動し、タイトルDOON Voiceのウィンドウ表示と生存確認に成功 |
| ライセンス | ソースとMSI内部の380件の原文・ハッシュ一致 |
| ZIP生成 | Windows上で成功。MSI、README、OSS、プライバシー、ライセンスを同梱 |

実認識では`ask not what your country can do for you`を含む本文を取得した。計測は4 CPUのCI環境であり、利用者PCの所要時間の保証ではない。[エンジン再ビルド](https://github.com/daisukubo-rgb/doon-voice/actions/runs/35052376981)でも互換版・AVX2版の直接参照DLL検査と単独起動に成功している。

Windows実行で発見したNodeのverbatimパス問題は、スクリプト引数だけ通常のWindowsパスへ正規化して修正した。通常・260文字超・日本語・記号を含むパスで実Node起動が成功。通常の子プロセス2系統のコンソール非表示と、明示したログインだけコンソールを開くテストも成功した。

Mac側はAVX2選択の全31不足組合せと欠落ファイルを含むRust111件成功・既存2件除外、Clippy成功。配布検査16件成功。Windowsの自動改行条件でも別フォルダへGitの内容を展開し、380件のライセンス・エンジンハッシュ照合に成功した。

## 配布物

- 配布用ZIP: `dist/DOON Voice-Windows.zip`（14,812,086 bytes、701項目）
- インストーラー: `dist/DOON Voice_0.5.19_x64_en-US.msi`（13,740,520 bytes）
- ZIP SHA-256: `3ae847250ec96003369e311242f17375c2a90c1a91a5044ded71887fa5f4ede0`
- MSI SHA-256: `18d47e0ad3705e14c89b83816110838850f19c964dd46770983bb86abec15ff2`

成功CIのartifactを取得後、同封READMEのマイク許可案内1行だけを、Mac専用のボタンとWindows設定を区別する文へ修正した。これは`package-installer-zip.mjs`の最終手順と一致する。CI原本ZIPのSHA-256は`1255625670f9453a2c58a30501ddb5cc74d7cb18bc6497246f42f4c13e1297a7`。全項目の一覧一致、README以外の全バイト一致、ZIPのCRC、別添MSIとのバイト一致、ライセンス全ファイルとソースの一致を確認した。プライバシー・OSS案内はWindowsの改行差を除きソースと一致する。MSIの変更・再ビルドはない。

既存`dist/DOON Voice-macOS.zip`は変更していない（SHA-256: `979d21079b0403233e49148910e50f2d5d6f2b7f722592a9a5334b7bcc46c728`）。

## 検証の限界

Windows CIはMicrosoftのWindows Server 2022 x64 runnerを使用する。Windows 10/11の物理PC、実マイク、利用者の入力先への貼り付け、実アカウントでの外部AI認証・通信は未確認。npmラッパーがさらに生成する子プロセスの画面挙動も全CLIでは確認していない。

配布物にコード署名証明書は付けていない。組織の端末制限やWindowsの起動警告は残り得る。一般公開Releaseは更新せず、テスト用artifactとローカルZIPを提供する。既存Mac配布0.5.18は保持する。
