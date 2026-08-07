#!/bin/bash
# 自分に発言の番が回っているルームがあれば、ターンの終了を止めて会話に戻す。

input=$(cat)

if echo "$input" | grep -qE '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  exit 0
fi

reason=$(cxtalk check) || exit 0

echo "$reason" >&2
exit 2
