#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-}"
FILE="${2:-}"
START="${3:-}"
ENDL="${4:-}"
COMMENT="${5:-}"
SELECTED="${6:-}"

if [[ -z "${PORT}" || -z "${FILE}" || -z "${START}" || -z "${ENDL}" || -z "${COMMENT}" || -z "${SELECTED}" ]]; then
  echo "用法：scripts/ann-create.sh <PORT> <FILE> <START> <END> <COMMENT> <SELECTED>" >&2
  exit 1
fi

jq -nc \
  --arg file "$FILE" \
  --arg start "$START" \
  --arg end "$ENDL" \
  --arg selected "$SELECTED" \
  --arg comment "$COMMENT" \
  '{filePath:$file, startLine:($start|tonumber), endLine:($end|tonumber), selectedText:$selected, comment:$comment, priority:"P1"}' \
  | curl -s -X POST "http://127.0.0.1:${PORT}/api/annotations" -H 'content-type: application/json' -d @- | jq .

