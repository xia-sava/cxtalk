# cxtalk 仕様（暫定）

起案: 2026-08-07

## 解決する問題

同一マシンで複数の Claude Code セッションを並行して動かすとき（例: `backend` と `frontend`）、
セッション間の情報の受け渡しを人間が仲介している。往復が増えるほど人間の手間が線形に増える。

既存手段の限界:

| 手段 | 限界 |
|---|---|
| 各 repo に md の送信箱を持ち append する | 相手が読みに行くタイミングを人間が作る必要がある。ファイルが肥大し、未読管理がない |
| メッセージを送るツールを用意する | 受信側のセッションは入力待ちで停止しているため、送っても届かない |

## 基本方針

停止中のセッションを外から起こすことはできない。そこで**両者が自発的に会話モードに入る**構成にする。

`receive` をロングポーリングにすれば、コマンド実行の内側で相手の発言を待てる。
コマンドはプロセスが終了するまで呼び出し側が待つため、
「相手が発言するまで終了しないコマンド」として実装できる。

```
BE                     cxtalk                     FE
 |  open                 |                         |
 |<-- "r-a3f9" ----------|                         |
 |                       |<-- join r-a3f9 ---------|
 |  say "..."            |                         |
 |---------------------->|------------------------>|  receive が返る
 |  receive …待機        |                         |
 |                       |<-- say "..." -----------|
 |  receive が返る <------|                         |  receive …待機
```

人間の操作は最初の `open` / `join` の 2 回だけで、以降の往復は自動で進む。

## 構成

状態は共有ディレクトリ上のファイルに置く。プロセス間で状態を共有するため、
常駐サーバを持たずコマンド実行のたびにファイルを読み書きする。

```
~/cxtalk/rooms/r-a3f9/
  room.json
  messages/
    0001-backend.md
    0002-frontend.md
    0003-backend.md
```

メッセージのファイル名に送信者を含めるため、万一連番が競合しても上書き事故にはならない。

状態の置き場は環境変数 `CXTALK_HOME` で変えられる。未設定なら `~/cxtalk` とする。

## 状態モデル

```json
{
  "id": "r-a3f9",
  "topic": "確認テストの合格基準は正答数か正答率か",
  "status": "open",
  "turn": "frontend",
  "hops": 3,
  "max_hops": 5,
  "stale_streak": 0,
  "last_activity_at": "2026-08-07T14:32:10+09:00",
  "participants": {
    "backend": { "last_read": 3, "timeouts": 0 },
    "frontend": { "last_read": 2, "timeouts": 1 }
  },
  "closed_reason": null
}
```

各フィールドが担う振る舞い:

| 振る舞い | フィールド | 判定 |
|---|---|---|
| 会話が終わらない問題 | `hops` / `max_hops` | 往復のたび +1、上限で close |
| 中身のない応酬の検知 | `stale_streak` | `advanced: false` で +1、`true` で 0 に戻す。2 で close |
| 双方が待ち合うデッドロック | `turn` | 自分の番なら `receive` は即座に返る |
| 応答が来ない | `participants[].timeouts` | `receive` タイムアウトで +1、上限で close |
| 放置されたルームの掃除 | `last_activity_at` | 30 分無音で close |
| 再入場時の差分取得 | `participants[].last_read` | これ以降のメッセージを返す |

### hops は往復で数える

`hops` は往復の回数であり、発言の回数ではない。両者が 1 回ずつ発言して 1 往復とする。
`say` はメッセージの通し番号 `seq` を進め、`hops` は `Math.ceil(seq / 2)` で求める。
`hops_left` は `max_hops - hops`。

`max_hops` の既定値 5 は、各参加者が 5 回まで発言できることを意味する。

### turn が二重に効く

発言権を `turn` で管理すると、デッドロック回避と同時書き込み防止が同時に成立する。
turn 制がある限り両者が同時に `say` することはないため、連番の採番でも競合しない。
ファイルロックやトランザクションを要しない。

### 死活監視は行わない

相手が長考中の場合、相手はコマンドを実行しないため最終アクセス時刻が更新されない。
これは相手のセッションが停止している場合と区別がつかない。長考は数分に及ぶことがあり、
閾値を短くすれば正常な相手を切断し、長くすれば停止した相手を待ち続ける。

したがって「相手が生きているか」は判定せず、「自分がいつまで待つか」だけを決める。

- 正常終了は明示的な `close`
- 待ちきれない場合は `receive` のリトライ上限
- 放置されたルームは `last_activity_at` によるアイドル掃除

## 参加者名

1. `--as` の指定があればそれ
2. 無ければ cwd の repo 名
3. **同名の参加者が既にいれば再入場として扱う**

別人として参加したい場合のみ、明示的に別名を名乗る。
再入場はターンが切れるたびに発生する頻繁な操作であり、
同一 repo で複数セッションを動かすのは稀であるため、頻繁な側を既定の動作にする。

在室状態は持たない。一度 `join` すれば close まで参加者であり、`join` は冪等。

## コマンド

```
cxtalk open   --topic <text> [--max-hops 5] [--as <name>]
cxtalk join   <room_id> [--as <name>]
cxtalk say    <room_id> --text <text> --advanced <true|false> [--as <name>]
cxtalk receive <room_id>... [--timeout 100] [--as <name>]
cxtalk status <room_id>
cxtalk close  <room_id> [--reason manual]
cxtalk ls
cxtalk check  [--as <name>] [--room <room_id>]
```

`check` 以外は JSON を stdout に出力する。

### 共通規約

すべてのサブコマンドが `ok` / `next` / `hint` を返す。
異常も終了コードで表さず、正常な JSON として返す。
実行失敗として返すと、受け取った側が独自の回復動作を始めることがあるため、
必ず次の行動を添えて返す。

`next` は 4 値のみ。

| next | 意味 |
|---|---|
| `say` | 発言する番 |
| `receive` | 相手を待つ |
| `report` | 会話終了。要約して人間に報告する |
| `ask_user` | 人間の入力が必要 |

`hint` は日本語で、具体的な行動を書く。受け取る側への指示として機能する。

---

### open

```json
{
  "ok": true,
  "room_id": "r-a3f9",
  "as": "backend",
  "topic": "確認テストの合格基準は正答数か正答率か",
  "max_hops": 5,
  "turn": "backend",
  "next": "ask_user",
  "hint": "ルームを開きました。ユーザーに『FE 側で cxtalk join r-a3f9 と伝えてください』と依頼してください。相手の参加を確認してから say で第一声を送ります。"
}
```

この時点で相手は room_id を知らないため、`next` は `say` ではなく `ask_user`。
`say` にすると、参加者のいないルームに発言して `receive` で待ち続けることになる。

---

### join

| 状況 | ok | status | next |
|---|---|---|---|
| 新規参加 | true | open | `receive` |
| 再入場・自分の番 | true | open | `say` |
| 再入場・相手の番 | true | open | `receive` |
| 閉じたルーム | true | closed | `report` |
| 存在しない room_id | false | — | `ask_user` |

```json
{
  "ok": true,
  "room_id": "r-a3f9",
  "as": "frontend",
  "rejoined": true,
  "topic": "確認テストの合格基準は正答数か正答率か",
  "status": "open",
  "hops_left": 3,
  "messages": [
    { "seq": 4, "from": "backend", "at": "2026-08-07T14:32:10+09:00",
      "text": "..." }
  ],
  "turn": "frontend",
  "next": "say",
  "hint": "未読 1 件。再入場です。"
}
```

`messages` は再入場なら `last_read` 以降の差分、新規参加なら全件。
閉じたルームへの join も `ok: true` で履歴を返す。要約を書くために読む必要があるため。

---

### say

`--advanced` は必須。省略可にすると省略されるため。

| 状況 | ok | next |
|---|---|---|
| 通常 | true | `receive` |
| hop 上限に到達 | true | `report` |
| stale 2 連続 | true | `report` |
| 自分の番でない | false | `receive` |
| 閉じている | false | `report` |

通常:

```json
{
  "ok": true, "seq": 5, "hops_left": 2,
  "turn": "backend", "next": "receive",
  "hint": "発言を記録しました。相手の応答を receive で待ってください。"
}
```

終端:

```json
{
  "ok": true, "seq": 6, "hops_left": 0,
  "status": "closed", "closed_reason": "hop_limit", "next": "report",
  "hint": "往復上限に達したのでルームを閉じました。合意できた点・未解決の点・持ち帰る宿題を要約してユーザーに報告してください。ここで出た結論は提案であり、実装はユーザーの承認を経てください。"
}
```

番でないのに say:

```json
{
  "ok": false, "error": "not_your_turn",
  "turn": "frontend", "next": "receive",
  "hint": "今は相手の発言待ちです。receive を呼んでください。"
}
```

#### advanced の申告基準

自己申告は楽観的に倒れやすく、要約しただけでも「論点を整理したので前進した」と判断されうる。
SKILL.md には抽象的な基準ではなく具体例を書く。

> 相手への同意・お礼・要約・確認だけの発言は `--advanced false`。

---

### receive

| 状況 | status | next |
|---|---|---|
| 新着あり | `message` | `say` |
| 時間切れ・リトライ残あり | `timeout` | `receive` |
| 時間切れ・リトライ残なし | `closed` (`no_response`) | `report` |
| 自分の番だった | `your_turn` | `say` |
| 相手が閉じた | `closed` | `report` |

新着:

```json
{
  "ok": true, "status": "message", "room_id": "r-a3f9",
  "messages": [ { "seq": 4, "from": "backend", "at": "...", "text": "..." } ],
  "hops_left": 2, "turn": "backend", "next": "say"
}
```

複数ルームを待てるため、`room_id` を必ず返す。

タイムアウト:

```json
{
  "ok": true, "status": "timeout", "waited_seconds": 100, "retries_left": 4,
  "next": "receive",
  "hint": "まだ応答がありません。相手が考え中の可能性が高いです（長考は珍しくありません）。receive を再度呼んでください。あと 4 回待てます。"
}
```

`retries_left` を明示する。残り回数が示されないと早期に待機を打ち切る判断がなされやすい。

自分の番だった場合は即座に返す。デッドロック回避の要。

```json
{ "ok": true, "status": "your_turn", "next": "say",
  "hint": "あなたの発言番です。待たずに say を呼んでください。" }
```

room_id は複数受ける。初期実装では 1 個しか渡さないが、
将来 3 者以上のルームを扱う際に互換性を壊さずに広げられる。

#### タイムアウトを 100 秒とする理由

呼び出し側の Bash 実行には既定のタイムアウト（120 秒）があり、
`receive` の待機がこれと競り合うと不可解な失敗になる。
100 秒であれば呼び出し側で何も指定しなくても既定値の内側に収まる。
長考への追随は 1 回の待機時間ではなくリトライ回数で確保する。

リトライ上限は 6 回とする。100 秒の待機と合わせて、応答を待つ時間は最大でおよそ 10 分になる。
上限に達した場合は `no_response` として close する。

---

### status

**副作用を持たない。** `last_read` を更新しない。
更新すると、確認しただけで既読になり取りこぼしを生む。

```json
{
  "ok": true, "room_id": "r-a3f9", "status": "open",
  "topic": "...", "turn": "frontend", "hops_left": 2,
  "unread": { "backend": 0, "frontend": 1 },
  "participants": ["backend", "frontend"],
  "last_activity_at": "2026-08-07T14:32:10+09:00"
}
```

---

### close

```json
{
  "ok": true, "closed_reason": "manual", "hops_used": 3,
  "next": "report",
  "hint": "ルームを閉じました。ここまでの内容を要約してユーザーに報告してください。"
}
```

---

### check

人間が介入する窓と、hook から呼ぶ判定に使う。他のサブコマンドと異なり、
JSON ではなく終了コードと 1 行のテキストで答える。

| exit | 意味 |
|---|---|
| 0 | 用がある（open ∧ 自分の turn ∧ 未読あり）。stdout に 1 行 |
| 1 | 用がない |
| 2 | エラー（room.json 破損等） |

```
$ cxtalk check --as backend
r-a3f9: frontend から 1 件（残り2往復）— 確認テストの合格基準は正答数か正答率か
$ echo $?
0
```

exit 2 は hook 側で「用なし」として扱う。破損したファイルで恒久的にブロックされると復帰できないため、安全側に倒す。

stdout の 1 行はそのまま hook の `reason` に流せる形式にする。hook 側でのパースを不要にする。

## 終了条件

| closed_reason | トリガー | 着地 |
|---|---|---|
| `hop_limit` | 往復が `max_hops` に到達 | 要約して人間へ |
| `stale` | `advanced: false` が 2 連続 | 要約して人間へ |
| `no_response` | `receive` のリトライ上限 | 相手が応答しない旨を人間へ |
| `idle` | 30 分無音 | 掃除（要約なし） |
| `manual` | 人間または一方が明示的に close | 要約して人間へ |

前 2 者が正常終了、残りが異常系。すべての終了が `next: "report"` に収束する。
このプロトコルには「会話が終わったら要約して人間に返す」以外の出口がない。

## Stop hook 連携

`receive` はターンの内側でしか待てない。会話が終わったと判断して人間に応答を返した後は、
相手が発言しても届かない。この取りこぼしを Stop hook が拾う。

```
ターンを終える
  → Stop hook が cxtalk check を叩く
  → exit 0 なら block
  → 再入場して会話を続ける
```

block する条件は **open ∧ 自分の turn ∧ 未読あり ∧ `stop_hook_active` が false** の
4 つすべて。閉じたルームで block すると抜けられなくなる。

`stop_hook_active` は Stop hook の入力に含まれ、block によって継続したターンで true になる。
Claude Code は連続した block を検知しないため、hook 側でこれを見ない限り止まらない。
このフラグは人間の入力ごとに false へ戻るため、条件に加えることで
block は入力 1 回につき最大 1 回に制限される。

block 時の表示には残り往復数を含める。人間が画面を見ていれば中断できる状態にする。

## 歯止め

自走する以上、人間の不在中に往復が進む。ルームの位置づけを次のように定める。

**ルームは論点を詰める場であり、決定する場ではない。** 成果物は「決定」ではなく
「整理された論点と、双方の見解」とする。決定は人間が行う。

3 つの歯止めを置く:

- `max_hops` の既定値を 5 とする
- 終端の `hint` に「結論は提案であり、実装はユーザーの承認を経ること」を含める
- Stop hook の block 時に残り往復数を表示する

歯止めを SKILL.md ではなくコマンドの出力側に置くのは、skill を読んでいない状態でも効かせるため。

## 実装

| 項目 | 決定 |
|---|---|
| 言語 | TypeScript |
| 実行 | Node 24 の type stripping により、ビルドせず `.ts` を直接実行 |
| 依存 | なし（標準ライブラリのみ。`node_modules` を持たない） |
| 構成 | 1 ファイル |
| 呼び出し | Bash ツールの `PATH` から `cxtalk` として実行。hook からも同じ |

型注釈を除去して実行する方式のため、ランタイム挙動を伴う構文（`enum` / `namespace` /
パラメータプロパティ）は使えない。union type と const オブジェクトで代用する。
型検査は実行時には行われないため、エディタまたは別途の `tsc` に委ねる。

終了コードは `process.exitCode` への代入で設定し、`process.exit()` は呼ばない。
Windows の Node 24 では、型注釈を除去した `.ts` が `fs` の同期 API と `process.exit()` を
併用するとプロセスが libuv のアサーション失敗で異常終了し、終了コードが 127 になる。
`check` は終了コードで結果を表すため、これを踏むと判定が成立しない。
`process.exit()` は保留中の標準出力の書き込みも切り捨てるため、いずれにせよ使わない。

`.ts` の直接実行は stderr に ExperimentalWarning を出力する。
`check` の出力を hook に渡す際のノイズになるため、shebang で
`--disable-warning=ExperimentalWarning` を渡して抑止する。

`package.json` は `{"type": "module"}` のみを持つ。これがないと import を含む `.ts` の
実行時に MODULE_TYPELESS_PACKAGE_JSON の警告が stderr に出力され、同じくノイズになる。
依存は持たないため `node_modules` は生じない。

### 呼び出しの前提

`bin/` に置いたものはプラグインが有効な間 Bash ツールの `PATH` に加わるため、
`cxtalk` の名前で呼べる。ただし**実行許可を settings に登録する**必要がある。
登録がないと往復のたびに許可を求められ、自走が成立しない。

### テスト

`node --test` で実行する。`node:test` と `node:assert` のみを使い、追加の依存を持たない。

コマンドを子プロセスとして起動し、標準出力の JSON と終了コードを検証する。
出力の形が仕様であるため、内部の関数ではなく外から見た振る舞いを対象にする。
`CXTALK_HOME` に一時ディレクトリを渡し、実データから隔離する。

## skill との分担

| | 担当 |
|---|---|
| コマンド | 機構。メッセージの保存・待機・カウント。決定論的な部分 |
| SKILL.md | 作法。いつ開くか、何を載せるか、どう閉じるか。判断を要する部分 |

SKILL.md とコマンド本体は同じプラグインに同梱する。
repo ごとに複製すると片方だけが更新され食い違うため。

## プラグインとしての構成

Claude Code のプラグインとして構成する。skill・hook・実行ファイルの置き場所が
仕様として定まっており、配置とパス解決を自前で用意せずに済む。

```
.claude-plugin/plugin.json
bin/cxtalk
src/cxtalk.ts
skills/cxtalk/SKILL.md
hooks/hooks.json
hooks/stop.sh
```

| 置き場所 | 役割 |
|---|---|
| `bin/` | プラグインが有効な間、Bash ツールの `PATH` に加わる |
| `skills/cxtalk/SKILL.md` | 作法 |
| `hooks/hooks.json` | Stop hook の登録。利用者が settings を編集せずに済む |

`bin/cxtalk` は `src/cxtalk.ts` を起動するラッパーとする。
型注釈の除去は拡張子で判定されるため、拡張子を持たない `bin/cxtalk` に実装を直接は置けない。

### 配置

`~/.claude/skills/cxtalk` を本 repo への symlink とする。
`.claude-plugin/plugin.json` を持つディレクトリはプラグインとして読まれ、
プラグインキャッシュに複製されずその場で参照されるため、repo が唯一の正になる。
marketplace への登録も install も要さず、次のセッションから `cxtalk@skills-dir` として読まれる。

開発中は `claude --plugin-dir <path>` で読み込み、`claude plugin validate <path>` で検証する。

## 初期実装に含めないもの

- **発言の繰り返し検知**（類似度計算による堂々巡りの検出）。実装量に対して閾値調整の見通しが立たない。
  `max_hops` と `stale_streak` で実際にどこまで止まるかを見てから判断する
- **3 者以上のルーム**。`receive` が複数の room_id を受ける形にしておくに留める
