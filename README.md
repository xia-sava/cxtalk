# cxtalk

同一マシンで並行して動く複数の Claude Code セッションを、直接会話させるためのツール。

backend repo と frontend repo でそれぞれセッションを動かしていると、
片方の判断をもう片方に伝えるために人間が仲介することになる。
往復が増えるほど手間が線形に増えるため、セッション同士が直接やりとりできるようにする。

## 仕組み

一方が room を開き、もう一方が room_id を受け取って参加する。
以降は `say` と `receive` の往復で会話が進む。

`receive` は相手が発言するまで終了しないため、待機はコマンド実行の内側で完結する。
停止中のセッションを外から起こす必要がない。

会話は規定の往復数に達するか、中身のない応酬が続いた時点で自動的に終了し、
双方に「要約して人間に報告する」よう促して閉じる。

詳細は [SPEC.md](SPEC.md) を参照。

## 要件

- Node.js 24 以上。型注釈を含む `.ts` をそのまま実行する
- bash。コマンドと Stop hook が bash スクリプトである
- Claude Code

依存パッケージは無い。ビルドも要らない。

動作を確認しているのは Windows 11 と git bash の組み合わせのみ。
macOS と Linux では試していない。

## 構成

Claude Code のプラグインとして構成している。

```
.claude-plugin/plugin.json       プラグインの定義
.claude-plugin/marketplace.json  配布用のカタログ
bin/cxtalk                       PATH に載るコマンド
src/cxtalk.ts                    実装
skills/cxtalk/SKILL.md           作法
hooks/hooks.json                 Stop hook の登録
hooks/stop.sh                    Stop hook の本体
test/cxtalk.test.ts              テスト
package.json                     モジュール種別の宣言
SPEC.md                          仕様
```

会話の実データは repo の外に置く。

```
~/cxtalk/rooms/<room_id>/
```

## 導入

どちらの形でも次のセッションから skill が読み込まれ、
`cxtalk` コマンドが Bash ツールの `PATH` に入る。

### marketplace から入れる

この repo は marketplace を兼ねている。

```
/plugin marketplace add xia-sava/cxtalk
/plugin install cxtalk@xia-sava
```

プラグインキャッシュへ複製されるため、更新するには
`/plugin marketplace update` と `/plugin update cxtalk` が要る。

### skills に直接置く

`~/.claude/skills/` の下へ clone する。

```
git clone https://github.com/xia-sava/cxtalk ~/.claude/skills/cxtalk
```

キャッシュへの複製を挟まないため、repo を更新すれば次のセッションに反映される。
`cxtalk@skills-dir` として読み込まれる。このツール自体に手を入れる場合はこちら。

### 実行許可の登録

settings に `cxtalk` の実行許可を登録する。
登録がないと往復のたびに許可を求められ、自走が成立しない。

## 開発

テストは Node の組み込みのテストランナーで動かす。追加の依存はない。

```
node --test
```

テストはコマンドを子プロセスとして起動し、標準出力の JSON と終了コードを検証する。
`CXTALK_HOME` に一時ディレクトリを渡すため、実際の会話データには触れない。

## ライセンス

MIT License. 詳細は [LICENSE](LICENSE) を参照。
