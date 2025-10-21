#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-}"
DIR="${2:-.}"
if [[ -z "${PORT}" ]]; then
  echo "用法：scripts/api-tree.sh <PORT> [DIR=.]" >&2
  exit 1
fi

curl -s "http://127.0.0.1:${PORT}/api/tree" --get --data-urlencode "dir=${DIR}" | jq .

