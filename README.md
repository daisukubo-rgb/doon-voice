# DOON Voice

話した内容を端末内で文字にし、選んだAIで自然な文章へ整えて、いまカーソルがある入力欄へ直接入力するデスクトップアプリです。音声入力の履歴は保存せず、利用者が登録した辞書だけを端末内に保存します。

このリポジトリはDOON Voiceだけで完結しています。ほかのDOONプロジェクトを一緒に取得する必要はありません。

## GitHubから起動する

ソースから起動する場合、macOSの署名やWindowsの証明書は不要です。利用者のPC上でアプリをビルドします。

GitHub ReleasesのAssetsにある `Source code (zip)` を取得し、先に中身をすべて展開してください。展開したフォルダを開き、OSに合うファイルをダブルクリックします。

- macOS: `DOON Voiceを起動.command`
- Windows: `DOON Voiceを起動.bat`

初回は環境確認とセットアップを行ってからDOON Voiceを起動します。2回目以降は、使用する部品に変更がなければセットアップを飛ばして起動します。Node.jsが入っていない場合はダウンロードページを開きます。Rustなどが不足している場合は、画面に準備内容を表示して停止します。

ターミナルから起動する場合は、次のコマンドを使います。

```bash
git clone https://github.com/daisukubo-rgb/doon-voice.git
cd doon-voice
npm run setup
npm run app
```

`npm run setup` はNode.js 20以上、Rust、macOSのXcode Command Line Toolsを確認し、依存関係をインストールします。確認だけ行う場合は `npm run doctor` を使います。

### 必要な環境

- macOS 12以降（Apple Silicon / Intel）: Xcode Command Line Tools、Node.js 20以上、Rust
- Windows 10/11（64ビット）: Node.js 20以上、Rust、Visual Studio Build Tools（C++）、WebView2

WindowsではRustの導入後に、Visual Studio Installerで「Desktop development with C++」を有効にしてください。

## 完成版インストーラーを使う

GitHubの [Releases](https://github.com/daisukubo-rgb/doon-voice/releases) からOSに合うファイルを取得します。

- macOS Apple Silicon: `DOON.Voice-macOS.zip` を展開し、中の `.dmg` を開きます。
- macOS Intel: `DOON.Voice-macOS-Intel.zip` を展開し、中の `.dmg` を開きます。
- Windows: `DOON.Voice-Windows.zip` を展開し、中の `.msi` を実行します。

GitHub Releasesには、各インストーラーを入れたZIPも添付します。ZIPを展開し、中のDMG（macOS）またはMSI/インストーラー（Windows）をダブルクリックしてください。配布ZIPには、初回設定と基本操作をまとめた `README.txt` も同梱しています。

初回起動後、`接続と設定` でDOON Voice専用の高精度音声認識モデル（約574MB）を取得してください。マイクを許可し、入力先にカーソルを置いて開始・停止キーを押すと、完成した文章がその入力欄へ直接入り、同時にクリップボードにも保存されます。

macOSでは「カーソル位置へ入力」の `許可する` を押し、システム設定のアクセシビリティで、現在 `Applications/DOON Voice.app` に置いたDOON Voiceをオンにしてください。マイクとアクセシビリティの許可はPCごとに必要です。同名のDOON Voiceが2つ表示される場合は、古い方を `−` で削除してから現在のアプリをオンにし、DOON Voiceを再起動してください。macOSの仕様上、この許可をアプリから自動で付与することはできません。

ショートカット操作中は、ほかのアプリより手前に `聞いています`、`文章を整えています`、`入力しました` の状態を表示します。DOON Voiceを最小化していてもショートカットは有効です。

## 文章を整えるAIを選ぶ

DOON Voiceは認証情報を保存しません。ChatGPT / Claudeのログインは利用者がPCに入れた公式CLIの画面で完結します。

| 選ぶAI | 必要な準備 | 使用モデル |
| --- | --- | --- |
| ChatGPT | Codex CLIとChatGPTアカウント | GPT-5.6 Luna（高速整形） |
| Claude | Claude CodeとClaudeアカウント | Claude Haiku（高速整形） |
| このPCのAI | Ollama | Gemma 4 E2B（DOON Voice専用・ローカル処理） |

接続と設定の `接続する` から公式CLIのログイン画面を開きます。ローカルAIを使う場合は `Ollamaを自動インストール`、続けて `Gemmaを取得` を選んでください。ローカルモデル（約7.2GB）は初回だけ取得し、配布物には含めません。

選択中のAIはホーム画面上部と「文章の仕上げ」の両方に表示されます。`接続可能`（CLI検出）、`接続中`、`接続済み`、`選択中`、`稼働中` を区別して表示します。

## プライバシー

- 認証トークン、メールアドレス、パスワード、APIキーをDOON Voiceは読み取り・保存しません。
- 録音ファイルは文字起こし直後に削除します。
- ChatGPT / Claudeを選んだ場合、整形する本文だけを各公式CLIへ渡します。
- ローカルAIを選んだ場合は `127.0.0.1` のOllamaだけを使い、本文を外部へ送信しません。

詳細は [プライバシーの扱い](docs/PRIVACY.md)、[利用条件](docs/TERMS.md)、[OSS表示](docs/OSS-NOTICES.md) を確認してください。

## 開発と配布

```bash
npm ci
npm run build          # フロントエンドの型チェックとビルド
npm run dist           # このPC向けのインストーラーを生成
npm run package:zip    # 生成済みインストーラーをZIPで包む
scripts/test-desktop-distribution.sh
```

`v0.5.3` のようなタグをGitHubへpushすると、GitHub ActionsがmacOS用 `.dmg` とWindows用 `.msi` をビルドし、公開Releaseへ添付します。公開前に各OSで音声認識・直接入力・AI接続を確認してください。購入者へは、個別ファイルではなく [公開Releaseページ](https://github.com/daisukubo-rgb/doon-voice/releases/latest) を案内してください。

ソースリポジトリの共有・各自ビルドには署名不要です。GitHub Releasesのインストーラーは未署名でも動作しますが、OSの警告を減らすにはApple公証とWindowsコード署名証明書を別途設定します。
