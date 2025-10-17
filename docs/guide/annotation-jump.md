# 代码查看器“标注跳转”方案（Monaco，只读）

本文记录“侧栏点击标注 → 主区滚动置顶并高亮”的技术方案与关键细节，作为后续实现与回归的参考。

## 目标与约束
- 目标：
  - 从侧栏点击某个绝对行/列范围（标注），主区代码查看器滚动到该范围、设置选区，并将范围“置于视图顶部”（可留少量顶部空白）。
- 约束：
  - 查看器为 Monaco 只读模式，支持分页（分片）加载与向上/向下拼接。
  - 页面可能开启自动换行（word wrap）。

## 核心状态（抽象）
```
state = {
  selectedPath: string | null,
  startLine: number,              // 分页起点（请求参数）
  pageSize: number,               // 分页大小
  chunkInfo: { start, end, total } | null,   // 当前位置模型覆盖的绝对行范围
  pendingJump: {
    startLine, endLine,
    startColumn?, endColumn?,
    id?, comment?
  } | null,
}
```

## 统一跳转通道（单次定位）
- 同片段：不重载；在现有模型上“滚动置顶 → 再设置选区”。
- 跨片段：只修改分页起点并设置 `pendingJump`；等待片段加载完成（onLoaded）后再统一定位。避免“侧栏即时滚动 + onLoaded 再滚动”叠加。
- 同一范围重复点击：不滚动（仅确保浮层/选区），防止闪烁。

## 偏移映射与拼接
- 偏移基准 `offsetStart` 必须使用“服务端真实返回”的 `startLine`（不是请求参数）。
- 绝对行 → 模型行映射：
  - `rel = clamp(abs - offsetStart + 1, 1, modelLineCount)`
- 向上拼接：在模型首行前插入上一片内容后，`offsetStart = prev.startLine`；向下拼接则更新 `endAbs`。

## 定位算法（先滚后选，Immediate）
- 计算：
  - `sRel = max(1, clamp((startAbs - offsetStart + 1), 1..N) - topPad)`
  - `eRel = clamp((endAbs - offsetStart + 1), 1..N)`
  - `selRange = Range(rawRelStart, startCol??1, eRel, endCol??maxCol)`
  - `revRange = Range(sRel, 1, sRel, 1)`（用于置顶）
- 顺序：
  1) 先滚：`revealRangeNearTop(revRange, Immediate)`（必要时退化为 `setScrollTop(getTopForLineNumber(sRel))`）
  2) 下一帧再选：`setSelection(selRange)`
  3) 40–60ms 后校验可见：不在视口则 `revealRangeInCenter(selRange, Immediate)` 兜底
- 置顶留白：`topPad` 默认 2–5 行，避免浮层遮挡让用户误感“不准”。
- 去重：若“同一跳转 key（行列范围）”且仍在视口内，则仅更新选区不滚动，避免闪烁。

## 抑制自动拼接（关键）
- 跳转期间设置 `isJumping=true`：onDidScroll 中直接返回，不触发 nearTop/nearBottom 拼接。
- 跳转后二、三百毫秒内可叠加一个 `suppressAutoLoadUntil = now + 400ms`，进一步防抖。
- 这样可避免“刚置顶立刻向上拼接，把目标行顶走”。

## wrap（自动换行）注意事项
- wrap=on 时尽量使用 `revealRangeNearTop/Center(Immediate)` 而非像素级 `setScrollTop`，减少行高换算误差。
- 若开启 wrap 仍有偏差，可适当增大 `topPad` 或在跳转的 1 帧内暂不依赖光标可见性逻辑。

## 伪代码（同片段即时定位）
```ts
function jumpTo(absStart, absEnd, startCol?, endCol?) {
  // 计算模型行，带 topPad
  const rawRel = clamp(absStart - offsetStart + 1, 1, modelLineCount)
  const sRel = Math.max(1, rawRel - topPad)
  const eRel = clamp(absEnd - offsetStart + 1, 1, modelLineCount)
  const selRange = range(rawRel, startCol ?? 1, eRel, endCol ?? lineEnd(eRel))
  const revRange = range(sRel, 1, sRel, 1)

  if (sameAsLast(selRange) && isVisible(selRange)) {
    setSelection(selRange)
    openPopover()
    return
  }
  isJumping = true
  suppressAutoLoadUntil = now + 400
  editor.revealRangeNearTop(revRange, Immediate)
  requestAnimationFrame(() => setSelection(selRange))
  setTimeout(() => {
    if (!isVisible(selRange)) editor.revealRangeInCenter(selRange, Immediate)
    isJumping = false
  }, 40)
}
```

## 伪代码（跨片段加载）
```ts
onClick(ann) {
  pendingJump = ann
  if (!inCurrentChunk(ann)) {
    startLine = centerAround(ann.startLine)
    // 等 onLoaded，再统一 jumpTo()
  } else {
    jumpTo(ann.startLine, ann.endLine, ann.startColumn, ann.endColumn)
    pendingJump = null
  }
}

onLoaded(data) {
  offsetStart = data.startLine   // 用真实返回值
  endAbs = data.endLine
  if (pendingJump) {
    const j = pendingJump; pendingJump = null
    jumpTo(j.startLine, j.endLine, j.startColumn, j.endColumn)
  }
}

onDidScroll() {
  if (isJumping) return
  if (nearTop) prependPrevChunk()
  if (nearBottom) appendNextChunk()
}
```

## 验收清单（回归用）
- 未打开文件：点击标注 → 激活文件并一次性置顶，开启浮层。
- 已打开同片段：点击标注 → 立即置顶（带 topPad），不开启拼接；重复点击同一标注不滚动。
- 跨片段：点击标注 → 触发加载 → onLoaded 后一次性置顶（仅一次滚动）。
- wrap=off/on 两种模式均稳定；小文件（整段加载）与大文件（需要拼接）均稳定。

## 交互规则（浮层开启时机）
- 侧栏点击标注：只进行滚动与高亮，不自动打开浮层。
- 编辑区行为：
  - 点击高亮（标注内联装饰）→ 打开浮层（编辑/查看该标注）。
  - 手动框选文本（selection-change）→ 打开浮层（新建/更新）。
  - 程序化跳转导致的 setSelection → 抑制一次 selection 回调，不触发浮层。

## 常见坑与修复要点
- 偏移错位：严禁以“请求参数 startLine”为偏移，必须用“返回 startLine”。
- 重复定位：侧栏与 onLoaded 不可各自滚一次，统一在一个通道里滚动一次即可。
- 时序冲突：尽量“先滚后选”，并用 Immediate；必要时下一帧设置选区。
- 自动拼接：跳转窗口内关闭拼接监听；否则很容易被 nearTop 顶走。
