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

仕様のみ。実装は未着手。

## 構成

```
SPEC.md          仕様
src/cxtalk.ts    実装（未着手）
skill/SKILL.md   ~/.claude/skills/cxtalk/ に配置する作法（未着手）
hooks/stop.sh    Stop hook のサンプル（未着手）
```

会話の実データは repo の外に置く。

```
~/cxtalk/rooms/<room_id>/
```

## 導入時の注意

### 実行許可の登録

Claude Code からは Bash 経由で実行するため、settings に実行許可を登録する。
登録がないと往復のたびに許可を求められ、自走が成立しない。

### `~/.claude/skills/` は git 追跡対象

`~/.claude` が git 管理されている場合、`.gitignore` の allowlist に `!/skills/` が
含まれていることがある。この状態で `~/.claude/skills/cxtalk/` を置くと、
本 repo と `~/.claude` の双方で同じものを管理することになる。

正を本 repo に置く場合は、`~/.claude/.gitignore` に除外を追加する。

```
/skills/cxtalk/
```
