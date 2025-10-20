#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=${1:-.}
COUNT=${2:-1000}
DIR="$ROOT_DIR/tmp-burst"

echo "[fs-burst] root=$ROOT_DIR count=$COUNT dir=$DIR"
mkdir -p "$DIR"

echo "[fs-burst] creating files..."
for i in $(seq 1 "$COUNT"); do
  f="$DIR/file_$i.txt"
  echo "hello $i" > "$f"
done

echo "[fs-burst] modifying files..."
for i in $(seq 1 "$COUNT"); do
  f="$DIR/file_$i.txt"
  echo "world $i" >> "$f"
done

echo "[fs-burst] deleting half..."
for i in $(seq 1 2 "$COUNT"); do
  f="$DIR/file_$i.txt"
  rm -f "$f" || true
done

echo "[fs-burst] done"

