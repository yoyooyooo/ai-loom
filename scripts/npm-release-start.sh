#!/usr/bin/env bash
set -euo pipefail

# Inputs (env with defaults)
TYPE="${TYPE:-patch}"        # patch|minor|major
BASE_BRANCH="${BASE:-main}"  # which branch to base from (remote)
PUSH="${PUSH:-0}"            # 1 to push new branch + tag
DRY_RUN="${DRY_RUN:-0}"      # 1 to preview only

echo "[release-start] syncing remote..."
git fetch --all --tags --prune || true

if ! printf "%s\n" patch minor major | grep -qx "$TYPE"; then
  echo "非法 TYPE：$TYPE（应为 patch|minor|major）" >&2
  exit 1
fi

# Ensure clean working tree
git update-index -q --refresh
if ! git diff-index --quiet HEAD --; then
  echo "工作区存在未提交变更，请先提交或暂存后再执行。" >&2
  exit 1
fi

# Compute next version from latest tag (supports vX.Y.Z and release-vX.Y.Z)
LAST_TAG=$(git tag --list 'v*.*.*' 'release-v*.*.*' | sed -E 's/^(release-)?v//' | awk -F. 'NF==3{printf "%d.%d.%d\n", $1,$2,$3}' | sort -n -t. -k1,1 -k2,2 -k3,3 | tail -n1 || true)
if [ -z "${LAST_TAG:-}" ]; then BASE_VER="0.0.0"; else BASE_VER="$LAST_TAG"; fi
IFS='.' read -r MA MI PA << EOF
${BASE_VER}
EOF
case "$TYPE" in
  major) NEW_VER="$((MA+1)).0.0";;
  minor) NEW_VER="${MA}.$((MI+1)).0";;
  patch) NEW_VER="${MA}.${MI}.$((PA+1))";;
esac

REL_BRANCH="release/v${NEW_VER}"
echo "[release-start] base=${BASE_BRANCH}, last=${BASE_VER}, new=${NEW_VER}, branch=${REL_BRANCH}"

if [ "$DRY_RUN" = "1" ]; then
  echo "[dry-run] 将创建分支：$REL_BRANCH 基于 origin/$BASE_BRANCH"
  echo "[dry-run] 将在该分支执行版本对齐与打 Tag：release-v${NEW_VER} ${PUSH:+(push=${PUSH})}"
  exit 0
fi

# Create release branch from remote base
if git rev-parse --verify --quiet "refs/heads/${REL_BRANCH}" >/dev/null; then
  echo "分支已存在：${REL_BRANCH}" >&2
  exit 1
fi

if git rev-parse --verify --quiet "refs/remotes/origin/${BASE_BRANCH}" >/dev/null; then
  git switch -c "${REL_BRANCH}" "origin/${BASE_BRANCH}"
else
  # fallback to local base branch if remote not found
  git switch -c "${REL_BRANCH}" "${BASE_BRANCH}"
fi

# Bump & tag within release branch
TYPE="$TYPE" PUSH="$PUSH" DRY_RUN="$DRY_RUN" VERSION="$NEW_VER" bash scripts/npm-bump-auto.sh

echo "[release-start] done: branch=${REL_BRANCH}, tag=release-v${NEW_VER}"

