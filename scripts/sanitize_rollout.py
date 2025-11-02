#!/usr/bin/env python3
"""简易 Codex rollout JSONL 去皮脚本。

基于以下策略对原始 rollout 进行“脱敏/瘦身”处理，便于比对：

- 逐行读取 JSONL，保留结构与字段键名不变。
- 针对字符串值，保留前 N 个字符（默认 80），其余以说明文字替代。
- 递归处理数组/对象，保持数字、布尔值等基础类型不变。

用法示例：

    python scripts/sanitize_rollout.py \
        /Users/yoyo/.codex/sessions/2025/11/01/foo.jsonl \
        --keep 120 \
        --out-dir /tmp/sanitized

若未显式提供输出路径，则默认在源文件旁生成
`<原文件名>.sanitized.jsonl`。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def truncate_string(value: str, keep: int) -> str:
    if len(value) <= keep:
        return value
    # 统一替换换行为空格，避免统计或 diff 时被换行干扰。
    head = value[:keep].replace("\n", " ")
    tail_len = len(value) - keep
    return f"{head}... [truncated {tail_len} chars]"


def sanitize(value: Any, keep: int) -> Any:
    if isinstance(value, str):
        return truncate_string(value, keep)
    if isinstance(value, list):
        return [sanitize(item, keep) for item in value]
    if isinstance(value, dict):
        return {key: sanitize(val, keep) for key, val in value.items()}
    # 其余类型（数字、布尔、None）保持不变
    return value


def process_file(path: Path, keep: int, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    total = 0
    with path.open("r", encoding="utf-8") as src, out_path.open(
        "w", encoding="utf-8"
    ) as dst:
        for line in src:
            raw = line.strip()
            if not raw:
                continue
            try:
                obj = json.loads(raw)
            except json.JSONDecodeError:
                # 非法行直接跳过，确保脚本健壮。
                continue
            sanitized = sanitize(obj, keep)
            dst.write(json.dumps(sanitized, ensure_ascii=True))
            dst.write("\n")
            total += 1
    print(f"sanitized {path} -> {out_path} ({total} lines)")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Sanitize Codex rollout JSONL files")
    parser.add_argument("paths", nargs="+", help="待处理的 rollout JSONL 路径")
    parser.add_argument(
        "--keep",
        type=int,
        default=80,
        help="字符串保留的前 N 个字符，默认为 80",
    )
    parser.add_argument(
        "--out",
        type=str,
        default=None,
        help="输出文件路径（仅当处理单个输入时可用）",
    )
    parser.add_argument(
        "--out-dir",
        type=str,
        default=None,
        help="输出目录，若未指定则与源文件同目录",
    )
    parser.add_argument(
        "--suffix",
        type=str,
        default=".sanitized.jsonl",
        help="输出文件名后缀，默认 .sanitized.jsonl",
    )

    args = parser.parse_args(argv)

    if args.out and len(args.paths) != 1:
        parser.error("--out 仅能在处理单个输入文件时使用")

    keep = max(args.keep, 0)

    for raw_path in args.paths:
        path = Path(raw_path).expanduser()
        if not path.exists():
            print(f"[skip] {path} 不存在", file=sys.stderr)
            continue

        if args.out:
            out_path = Path(args.out).expanduser()
        else:
            base_dir = Path(args.out_dir).expanduser() if args.out_dir else path.parent
            out_path = base_dir / f"{path.name}{args.suffix}"

        process_file(path, keep, out_path)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
