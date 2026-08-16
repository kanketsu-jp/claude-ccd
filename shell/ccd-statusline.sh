#!/bin/sh
json=$(cat)
printf '%s' "$json" | ccd hook usage >/dev/null 2>&1 &

# 既存 statusline と組み合わせる場合は、このスクリプトの引数として渡す。
if [ "$#" -gt 0 ]; then
  printf '%s' "$json" | "$@"
fi
