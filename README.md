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

会話はどこかで必ず終わる。終わり方は 5 つある。

| 終わり方 | 条件 |
|---|---|
| 往復の上限 | 開くときに決めた往復数に達した |
| 中身のない応酬 | 論点が前に進まない発言が 2 回続いた |
| 応答がない | 待機が 10 分に達した |
| 放置 | 30 分無音のまま |
| 明示的な終了 | どちらかが打ち切った |

どの終わり方でも、双方に「要約して人間に報告する」よう促して閉じる。

**席を外すなら 30 分と 10 分は知っておく必要がある。**
相手の参加を待っている間も 10 分で打ち切られるため、
room_id を渡してから相手のセッションで実行するまでが空くと、会話は始まらない。

詳細は [SPEC.md](SPEC.md) を参照。

## 要件

- Node.js 24 以上。型注釈を含む `.ts` をそのまま実行する
- bash。コマンドと Stop hook が bash スクリプトである。
  cmd.exe と PowerShell はシェバンを解釈しないため、そこからは直接実行できない
- Claude Code

依存パッケージは無い。ビルドも要らない。

動作を確認しているのは Windows 11 の git bash と Cygwin。
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
LICENSE                          MIT License
```

会話の実データは repo の外に置く。

```
~/cxtalk/rooms/<room_id>/
```

## 会話中に上限を変える

往復の上限を変えるコマンドは無い。歯止めを会話する側が動かせないようにしてあるため、
足りなくなったときに変えられるのは人間だけになる。
`~/cxtalk/rooms/<room_id>/room.json` の `max_hops` を書き換える。

**値の形を外すとそのルームは読めなくなる。** `max_hops` は 1 以上の整数で、
`"10回"` のように書くと全コマンドが `corrupt_room` を返し、
会話を続けることも終了することもできなくなる。読めない理由は出力の `hint` に出る。

会話中のセッションには条件が変わった事実しか届かない。
書き換えたことは、どちらかのセッションから発言として残してもらう。

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

`~/.claude/settings.json` に `cxtalk` の実行許可を登録する。

```json
{
  "permissions": {
    "allow": ["Bash(cxtalk:*)"]
  }
}
```

登録がないと往復のたびに許可を求められ、自走が成立しない。
人間が席を外している間に会話を進めることがこのツールの前提なので、
ここを省くと成り立たない。

## 開発

テストは Node の組み込みのテストランナーで動かす。追加の依存はない。

```
node --test
```

テストはコマンドを子プロセスとして起動し、標準出力の JSON と終了コードを検証する。
`CXTALK_HOME` に一時ディレクトリを渡すため、実際の会話データには触れない。

**全件で 5 分前後かかり、実行ごとに数分の幅で揺れる。** 待機の上限や掃除の条件を
実際に待つテストが含まれ、うち 1 件は待機の既定値である 100 秒をそのまま待つ。
残りの時間は 260 近いプロセス起動が占めるため、環境によって大きく前後する。
途中で止まっているように見えても打ち切らない。

## ライセンス

MIT License. 詳細は [LICENSE](LICENSE) を参照。
