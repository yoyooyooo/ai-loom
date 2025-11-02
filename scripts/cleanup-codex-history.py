#!/usr/bin/env python3
"""清理 ~/.codex/history.jsonl 中已不存在的会话记录。

运行方式：

    python scripts/cleanup-codex-history.py

脚本会：
1. 扫描 ~/.codex/sessions/**，解析现存 rollout JSONL 文件的会话 ID。
2. 重写 history.jsonl，只保留仍存在对应会话文件的行。
3. 输出统计信息，并自动备份原始 history.jsonl（同目录下追加 .bak）。

如需自定义 Codex 目录，可设置环境变量 CODEX_HOME。
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from shutil import copy2
from typing import Optional, Set


def codex_home() -> Path:
    env = os.environ.get("CODEX_HOME")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".codex"


def iter_rollout_files(root: Path):
    if not root.exists():
        return
    for path in root.rglob("rollout-*.jsonl"):
        if path.is_file():
            yield path


def extract_session_id(path: Path) -> Optional[str]:
    try:
        with path.open("r", encoding="utf-8") as fh:
            for raw in fh:
                line = raw.strip()
                if not line:
                    continue
                try:
                    data = json.loads(line)
                except json.JSONDecodeError:
                    continue
                payload = data.get("payload")
                if isinstance(payload, dict):
                    candidate = payload.get("id")
                    if isinstance(candidate, str):
                        return candidate
                candidate = data.get("id")
                if isinstance(candidate, str):
                    return candidate
    except OSError:
        return None
    return None


def collect_existing_sessions(root: Path) -> Set[str]:
    sessions: Set[str] = set()
    for file_path in iter_rollout_files(root):
        sid = extract_session_id(file_path)
        if sid:
            sessions.add(sid)
    return sessions


def cleanup_history(history_path: Path, valid_sessions: Set[str]) -> int:
    if not history_path.exists():
        return 0

    backup_path = history_path.with_suffix(".jsonl.bak")
    copy2(history_path, backup_path)

    removed = 0
    with history_path.open("r", encoding="utf-8") as src, history_path.open(
        "w", encoding="utf-8"
    ) as dst:
        for line in src:
            stripped = line.strip()
            if not stripped:
                dst.write(line)
                continue
            try:
                data = json.loads(stripped)
            except json.JSONDecodeError:
                dst.write(line)
                continue
            session_id = data.get("session_id")
            if isinstance(session_id, str) and session_id not in valid_sessions:
                removed += 1
                continue
            dst.write(line)
    return removed


def main() -> int:
    parser = argparse.ArgumentParser(description="清理 Codex history.jsonl 中的孤儿会话记录")
    parser.add_argument(
        "--sessions-root",
        type=Path,
        default=None,
        help="可选，指定 sessions 目录（默认读取 CODEX_HOME/sessions）",
    )
    parser.add_argument(
        "--history",
        type=Path,
        default=None,
        help="可选，指定 history.jsonl 路径（默认 CODEX_HOME/history.jsonl）",
    )
    args = parser.parse_args()

    home = codex_home()
    sessions_root = args.sessions_root or home / "sessions"
    history_path = args.history or home / "history.jsonl"

    if not sessions_root.exists():
        print(f"sessions 目录不存在：{sessions_root}")
        return 1

    valid_sessions = collect_existing_sessions(sessions_root)
    print(f"扫描会话完成，保留 {len(valid_sessions)} 个有效会话 ID")

    removed = cleanup_history(history_path, valid_sessions)
    if removed:
        print(
            f"已重写 {history_path}，移除 {removed} 条缺失会话的记录（备份：{history_path}.bak）"
        )
    else:
        print("history.jsonl 未发现需要移除的记录")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
