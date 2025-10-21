#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-}"
if [[ -z "${PORT}" ]]; then
  echo "用法：scripts/ann-list.sh <PORT>" >&2
  exit 1
fi

curl -s "http://127.0.0.1:${PORT}/api/annotations" | jq .

