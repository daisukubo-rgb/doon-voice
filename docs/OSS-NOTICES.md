# DOON Voice OSS表示

DOON Voiceが使用するOSSの表示です。npmとRustの固定バージョンに対応する原文資料を `licenses/` に収録し、本ファイルとともにアプリと配布ZIPへ同梱します。本文が公開されていない依存の宣言と、Windowsの追加DLLに関する確認事項は下記に分けて記載しています。

`licenses/inventory.json` に依存名・バージョン・ライセンス宣言・資料の入手元・SHA-256を記録しています。RustはApple Silicon、Intel Mac、Windows x64の依存を列挙しており、ビルド時だけ使用する依存も含みます。列挙と原文同梱の検査は、全依存の法的適合性を保証するものではありません。

## 原文資料と更新

- npm: `licenses/npm/`。LucideのISC本文・権利者表示、React、フォントなど、導入済みパッケージの実LICENSEを収録します。
- Rust: `licenses/cargo/`。CPAL v0.16.0のApache-2.0全文、TauriなどのLICENSE/NOTICE/COPYRIGHTを収録します。crateにない場合は同じソースコミットの上流資料を確認します。
- エンジンとWindows DLL: `licenses/engine/` と `licenses/engine-inventory.json`。入手元を確認できた資料と、バイナリの一覧を記録します。

依存更新後は `node scripts/collect-licenses.mjs` を実行します。`node scripts/check-licenses.mjs` はロックファイルと資料のハッシュを照合します。ReleaseではDMG/MSIを展開し、実際に同梱された資料も検査します。

## 残る確認事項

sigchld v0.2.4は、公開crateと記録されたソースコミットにLICENSE本文・著作権表示がありません。`licenses/cargo/sigchld-0.2.4/LICENSE-DECLARATION.toml` に上流のMIT宣言をそのまま収録しています。[該当ソース](https://github.com/oconnor663/sigchld.rs/tree/07b95e2fe38b18b376b0f635f2766bf2e641b80b) の表示については権利者確認が必要です。

Windows用のMicrosoft Visual C++ランタイムDLLはOSSではありません。既存DLLの由来・バージョンに対応する再配布条件の確認が必要です。Microsoftは、再配布をVisual Studioの利用資格とライセンス条件に従うものとしています。[公式の再配布説明](https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files) を参照してください。DOON Voiceが全DLLの再配布許諾を確認済みであるという記載ではありません。

Windows音声エンジンにはVCOMP140.DLLの依存があります。現行同梱物だけでクリーン端末の依存が満たされることは未確認です。CIでは音声エンジンの実起動を必須化していますが、CI端末に既存のランタイムがある場合も通るため、新規Windows環境の確認を代替しません。未確認のDLLは今回追加していません。

| コンポーネント | 主なライセンス |
| --- | --- |
| whisper.cpp v1.9.2 | MIT |
| OpenAI Whisperモデル | MIT |
| Gemma 4 E2B | Apache-2.0 |
| CPAL v0.16.0 | Apache-2.0 |
| Tauri / tokio / reqwest | MIT または Apache-2.0 |
| React | MIT |
| lucide | ISC |
| RocknRoll One | SIL Open Font License 1.1 |

## whisper.cpp v1.9.2

MIT License

Copyright (c) 2023-2026 The ggml authors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## OpenAI Whisper

MIT License

Copyright (c) 2022 OpenAI

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

各依存の著作権・ライセンスの詳細は、`licenses/` に記録された実際の原文資料を確認してください。

Gemma 4 E2BはDOON Voiceの配布物に同梱せず、利用者が「モデルを取得」を選んだ時にOllama公式レジストリから取得します。適用ライセンスはモデルの公式マニフェストに含まれるApache License 2.0です。

CPAL（Cross-Platform Audio Library）は、DOON Voiceの録音に使用します。CPAL v0.16.0のApache License 2.0全文を `licenses/cargo/cpal-0.16.0/LICENSE` に収録しています。

## RocknRoll One

Copyright 2020 The RocknRoll Project Authors (https://github.com/fontworks-fonts/RocknRoll)

This Font Software is licensed under the SIL Open Font License, Version 1.1.

SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007

PREAMBLE

The goals of the Open Font License (OFL) are to stimulate worldwide development of collaborative font projects, to support the font creation efforts of academic and linguistic communities, and to provide a free and open framework in which fonts may be shared and improved in partnership with others.

The OFL allows the licensed fonts to be used, studied, modified and redistributed freely as long as they are not sold by themselves. The fonts, including any derivative works, can be bundled, embedded, redistributed and/or sold with any software provided that any reserved names are not used by derivative works. The fonts and derivatives, however, cannot be released under any other type of license. The requirement for fonts to remain under this license does not apply to any document created using the fonts or their derivatives.

DEFINITIONS

“Font Software” refers to the set of files released by the Copyright Holder(s) under this license and clearly marked as such. This may include source files, build scripts and documentation.

“Reserved Font Name” refers to any names specified as such after the copyright statement(s).

“Original Version” refers to the collection of Font Software components as distributed by the Copyright Holder(s).

“Modified Version” refers to any derivative made by adding to, deleting, or substituting — in part or in whole — any of the components of the Original Version, by changing formats or by porting the Font Software to a new environment.

“Author” refers to any designer, engineer, programmer, technical writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS

Permission is hereby granted, free of charge, to any person obtaining a copy of the Font Software, to use, study, copy, merge, embed, modify, redistribute, and sell modified and unmodified copies of the Font Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components, in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled, redistributed and/or sold with any software, provided that each copy contains the above copyright notice and this license. These can be included either as stand-alone text files, human-readable headers or in the appropriate machine-readable metadata fields within text or binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font Name(s) unless explicit written permission is granted by the corresponding Copyright Holder. This restriction only applies to the primary font name as presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font Software shall not be used to promote, endorse or advertise any Modified Version, except to acknowledge the contribution(s) of the Copyright Holder(s) and the Author(s) or with their explicit written permission.

5) The Font Software, modified or unmodified, in part or in whole, must be distributed entirely under this license, and must not be distributed under any other license. The requirement for fonts to remain under this license does not apply to any document created using the Font Software.

TERMINATION

This license becomes null and void if any of the above conditions are not met.

DISCLAIMER

THE FONT SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM OTHER DEALINGS IN THE FONT SOFTWARE.
