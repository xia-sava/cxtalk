#!/bin/bash
# 自分に発言の番が回っているルームがあれば、ターンの終了を止めて会話に戻す。
# 入力の解釈は cxtalk 側で行う。ここに置くと、綴りの揺れで止め続ける側へ倒れる。

# これは全セッションのターン終了で走る。会話していないセッションが実装を読み込むと、
# 用の無いプロセス起動だけが毎回積み上がる。控えの有無は組み込みだけで見る。
sid="${CLAUDE_CODE_SESSION_ID:-}"
[ -n "$sid" ] || exit 0
[ -e "${CXTALK_HOME:-$HOME/cxtalk}/awake/$sid" ] || exit 0

# hook のシェルは PATH を引き継がない。bin と同じく置き場所から辿る。
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

reason=$("$root/bin/cxtalk" check --hook true) || exit 0

echo "$reason" >&2
exit 2
