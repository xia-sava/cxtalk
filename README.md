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

## 状態

仕様とテストは完成。`src/cxtalk.ts` は未実装。

## 構成

Claude Code のプラグインとして構成している。

```
.claude-plugin/plugin.json   プラグインの定義
bin/cxtalk                   PATH に載るコマンド
src/cxtalk.ts                実装（未着手）
skills/cxtalk/SKILL.md       作法（未着手）
hooks/hooks.json             Stop hook の登録
hooks/stop.sh                Stop hook の本体
test/cxtalk.test.ts          テスト
package.json                 モジュール種別の宣言
SPEC.md                      仕様
```

会話の実データは repo の外に置く。

```
~/cxtalk/rooms/<room_id>/
```

## 導入

`~/.claude/skills/cxtalk` を本 repo への symlink にする。
次のセッションから `cxtalk@skills-dir` として読み込まれ、
`cxtalk` コマンドが Bash ツールの `PATH` に入る。

```
ln -s /path/to/cxtalk ~/.claude/skills/cxtalk
```

### 実行許可の登録

settings に `cxtalk` の実行許可を登録する。
登録がないと往復のたびに許可を求められ、自走が成立しない。

### `~/.claude/skills/` は git 追跡対象

`~/.claude` が git 管理されている場合、`.gitignore` の allowlist に `!/skills/` が
含まれていることがある。この状態で `~/.claude/skills/cxtalk` を置くと、
本 repo と `~/.claude` の双方で同じものを管理することになる。

正を本 repo に置く場合は、`~/.claude/.gitignore` に除外を追加する。

```
/skills/cxtalk/
```

## 開発

テストは Node の組み込みのテストランナーで動かす。追加の依存はない。

```
node --test
```

テストはコマンドを子プロセスとして起動し、標準出力の JSON と終了コードを検証する。
`CXTALK_HOME` に一時ディレクトリを渡すため、実際の会話データには触れない。
