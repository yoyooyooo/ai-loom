#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")"/.. && pwd)
APP_SERVER_RS="$PROJECT_ROOT/packages/rust/ailoom-server/src/services/codex/app_server.rs"
CARGO_TOML="$PROJECT_ROOT/packages/rust/ailoom-server/Cargo.toml"

if [[ ! -f "$APP_SERVER_RS" || ! -f "$CARGO_TOML" ]]; then
  echo "[check-codex-version] unable to locate expected files" >&2
  exit 1
fi

cli_version="${1:-}"
if [[ -z "$cli_version" ]]; then
  cli_version=$(grep -oE '"[0-9]+\.[0-9]+\.[0-9]+"' "$APP_SERVER_RS" | head -n1 | tr -d '"')
fi

if [[ -z "$cli_version" ]]; then
  echo "[check-codex-version] failed to detect Codex CLI version from app_server.rs" >&2
  exit 1
fi

declared_revs=$(grep -oE 'rev *= *"[0-9a-f]+"' "$CARGO_TOML" | sed -E 's/.*"([0-9a-f]+)"/\1/' | sort -u)
rev_count=$(echo "$declared_revs" | awk 'NF{count++} END{print count+0}')
if [[ "$rev_count" -eq 0 ]]; then
  echo "[check-codex-version] no git rev declarations found in Cargo.toml" >&2
  exit 1
fi
if [[ "$rev_count" -gt 1 ]]; then
  echo "[check-codex-version] inconsistent codex crate revisions detected:" >&2
  echo "$declared_revs" >&2
  exit 1
fi
cargo_rev=$(echo "$declared_revs")

remote_ref="refs/tags/rust-v${cli_version}^{}"
remote_sha=$(git ls-remote https://github.com/openai/codex.git "$remote_ref" | awk '{print $1}' | head -n1)
if [[ -z "$remote_sha" ]]; then
  echo "[check-codex-version] failed to resolve tag $remote_ref" >&2
  exit 1
fi

if [[ "$remote_sha" != "$cargo_rev" ]]; then
  echo "[check-codex-version] mismatch detected" >&2
  echo "  CLI version : $cli_version ($remote_sha)" >&2
  echo "  Cargo rev   : $cargo_rev" >&2
  exit 1
fi

echo "Codex CLI version $cli_version matches Cargo rev $cargo_rev"
