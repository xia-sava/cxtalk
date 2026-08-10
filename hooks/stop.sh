#!/bin/bash
# 自分に発言の番が回っているルームがあれば、ターンの終了を止めて会話に戻す。
# 入力の解釈は cxtalk 側で行う。ここに置くと、綴りの揺れで止め続ける側へ倒れる。

# hook のシェルは PATH を引き継がない。bin と同じく置き場所から辿る。
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

reason=$("$root/bin/cxtalk" check --hook true) || exit 0

echo "$reason" >&2
exit 2
