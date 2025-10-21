#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-}"
FILE="${2:-}"
START="${3:-1}"
MAX="${4:-2000}"
if [[ -z "${PORT}" || -z "${FILE}" ]]; then
  echo "用法：scripts/api-file.sh <PORT> <FILE> [START=1] [MAX=2000]" >&2
  exit 1
fi

curl -s "http://127.0.0.1:${PORT}/api/file" \
  --get --data-urlencode "path=${FILE}" \
  --data-urlencode "startLine=${START}" \
  --data-urlencode "maxLines=${MAX}" | jq .

