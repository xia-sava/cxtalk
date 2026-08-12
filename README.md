# cxtalk

同一マシンで並行して動く複数の Claude Code セッションを、直接会話させるためのツール。

backend repo と frontend repo でそれぞれセッションを動かしていると、
片方の判断をもう片方に伝えるために人間が仲介することになる。
往復が増えるほど手間が線形に増えるため、セッション同士が直接やりとりできるようにする。

人間がすることは、片方に会話を開かせて、返ってきた room_id をもう片方に渡すことだけ。
あとは席を外していても往復が進み、話がついたところで双方が要約を返す。
放っておいても必ず終わるので、延々と往復し続けることはない。

設計と仕様は [SPEC.md](SPEC.md)、入れた後の運用と診断は [OPERATIONS.md](OPERATIONS.md)。

## 要件

- Node.js 24 以上。型注釈を含む `.ts` をそのまま実行する
- bash。コマンドと Stop hook が bash スクリプトである。
  cmd.exe と PowerShell はシェバンを解釈しないため、そこからは直接実行できない
- Claude Code

依存パッケージは無い。ビルドも要らない。

動作を確認しているのは Windows 11 の git bash と Cygwin。
macOS と Linux では試していない。

## 導入

どちらの形でも、次に起動したセッションから使えるようになる。

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
このツール自体に手を入れる場合はこちら。

## 試す

1. Claude Code のセッションを 2 つ起動する
2. 片方に「cxtalk でルームを開いて、<相談させたいこと> を詰めて」と頼む
3. 返ってきた room_id をもう片方に渡し、「cxtalk のルーム <room_id> に参加して」と頼む

あとはセッション同士が往復し、閉じたところで双方が要約を返す。

**同じディレクトリで 2 つ動かすなら、名乗りを分けるよう頼む。**
既定の名乗りは作業ディレクトリの名前で、両方が同じ名前になると 2 人目の参加が
再入場として扱われる。**どちらにもエラーは出ないまま、両方が相手を待ち続ける。**

うまくいかないときは [OPERATIONS.md](OPERATIONS.md)。

## 開発

```
node --test
```

全件だとすぐには終わらない。実時間を待つテストが含まれるため、途中で打ち切らない。

何をどう検証しているかは [SPEC.md](SPEC.md) の `### テスト`。

## ライセンス

MIT License. 詳細は [LICENSE](LICENSE) を参照。
