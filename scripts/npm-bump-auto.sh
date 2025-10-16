#!/usr/bin/env bash
set -euo pipefail

# Env inputs (with defaults)
TYPE="${TYPE:-patch}"      # patch|minor|major
PUSH="${PUSH:-0}"          # 1 to push branch+tags
DRY_RUN="${DRY_RUN:-0}"    # 1 to preview only
VERSION="${VERSION:-}"     # override target version (X.Y.Z)

# Try syncing remote tags first (non-fatal on failure)
echo "[auto-bump] fetching remote tags..."
git fetch --tags --prune origin || echo "[auto-bump] fetch --tags 失败，使用本地 tags 继续"

if ! printf "%s\n" patch minor major | grep -qx "$TYPE"; then
  echo "非法 TYPE：$TYPE（应为 patch|minor|major）" >&2
  exit 1
fi

# Compute base from latest vX.Y.Z tag
# Collect latest tag from both patterns: vX.Y.Z and release-vX.Y.Z
LAST_TAG=$(git tag --list 'v*.*.*' 'release-v*.*.*' | sed -E 's/^(release-)?v//' | awk -F. 'NF==3{printf "%d.%d.%d\n", $1,$2,$3}' | sort -n -t. -k1,1 -k2,2 -k3,3 | tail -n1 || true)
if [ -z "${LAST_TAG:-}" ]; then BASE="0.0.0"; else BASE="$LAST_TAG"; fi
if [ -n "$VERSION" ]; then
  NEW="$VERSION"
else
  IFS='.' read -r MA MI PA << EOF
${BASE}
EOF
  case "$TYPE" in
    major) NEW="$((MA+1)).0.0";;
    minor) NEW="${MA}.$((MI+1)).0";;
    patch) NEW="${MA}.${MI}.$((PA+1))";;
  esac
fi

echo "[auto-bump] last tag: release-v${BASE} -> new: release-v${NEW}"

if [ "$DRY_RUN" = "1" ]; then
  echo "[dry-run] 将执行：node scripts/bump-npm-version.mjs --version ${NEW}"
  echo "[dry-run] 将提交并打 Tag：release-v${NEW} ${PUSH:+(push=${PUSH})}"
  exit 0
fi

node scripts/bump-npm-version.mjs --version "$NEW"
git add packages/npm/**/package.json
if ! git diff --cached --quiet; then
  git commit -m "chore(release): npm bump to ${NEW}"
fi

if git rev-parse -q --verify "refs/tags/release-v${NEW}" >/dev/null; then
  echo "[auto-bump] Tag release-v${NEW} 已存在，跳过创建"
else
  git tag -a "release-v${NEW}" -m "release-v${NEW}"
fi

if [ "$PUSH" = "1" ]; then
  BR=$(git rev-parse --abbrev-ref HEAD || echo HEAD)
  git push --follow-tags origin "$BR"
else
  echo "[auto-bump] 本地完成，未推送（PUSH=0）"
fi
