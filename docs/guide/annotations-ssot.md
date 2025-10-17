# 批注交互 SSoT（跳转 / 浮层 / 高亮）

本文作为“批注交互”的单一事实来源（SSoT），规范 Editor（Monaco）与 Markdown 预览两种模式下的：侧栏跳转、浮层定位、滚动跟随、点击/划选、关闭策略与性能要求，并给出与代码实现的映射。

## 背景与目标
- 两种查看模式：Editor（Monaco 只读/可编辑）与 Markdown 预览（HTML 渲染）。
- 核心目标：
  - 无闪烁：首次打开浮层不得在 (0,0) 或屏幕顶部短暂出现。
  - 跟随滚动：打开后滚动时，浮层稳定跟随对应高亮位置。
  - 左对齐：视觉与正文首列对齐（考虑容器 padding + 微调）。
  - 列级精度：Markdown 划选→新建的高亮，与当时的选择精确一致（到列）。
  - 关闭策略：ESC 关闭；Editor 可点外部关闭；Markdown 点外部关闭需严格判定（防滚动误关）。
  - 模式隔离：Editor / Markdown 分别独立实现，行为一致、实现不同。

## 名词
- 高亮/标注/标记：黄色的内联高亮区域。
- 批注浮层：点击高亮或划选后出现的可编辑面板（文本域、按钮）。
- 锚点 / anchorRect：用于浮层定位的矩形（x/y/width/height）。
- 容器 / 滚动容器：正文滚动区域。Editor 为 Monaco 容器；Markdown 为预览容器。
- 侧栏跳转：从左侧批注列表点击某条批注，在正文视图定位到对应区间。

---

## 总体原则
- 首帧 gating：锚点与坐标就绪后再显示浮层；未就绪时不挂载或隐藏到屏幕外（-10000,-10000，透明、不可点）。
- 聚焦策略：统一 `focus({ preventScroll: true })`，在锚点/坐标就绪后再聚焦。
- 滚动与尺寸：使用 rAF 合批 + 监听滚动容器与 window（捕获）+ ResizeObserver，避免抖动。
- 关闭策略：ESC 关闭统一支持；点击外部关闭的判定在两模式不同（见下）。

---

## Editor 模式（Monaco）
- 定位与容器
  - 浮层采用“容器内绝对定位”（absolute within container）。
  - 锚点来自 Monaco 选择范围或命中装饰范围（inline 高亮）。
  - 锚点计算：
    - 使用 `getScrolledVisiblePosition` 取得起止点的像素坐标。
    - left = 容器 `getBoundingClientRect().left` + `layoutInfo.contentLeft` + `leftTweak`。
    - top 优先上方（不足则下方），保留 `offset=8px`。
- 滚动跟随
  - 监听 `onDidScrollChange` 复算锚点（优先当前选择，否则最近命中装饰范围），浮层稳定跟随。
- 侧栏跳转
  - 只滚动定位，不自动打开浮层；顶部预留 `topPadLines` 行，避免浮层遮挡。
  - 若目标不在当前分片：调整分页起点，等 `onLoaded` 后统一 reveal（单次滚动）。
- 点击/划选
  - 点击高亮：打开浮层并锚定到该范围附近。
  - 划选松手：打开浮层并以选择范围为锚点。
- 关闭
  - 支持 ESC；支持点击外部关闭（Editor 模式下无滚动误关问题）。
- 稳定性（实现要点）
  - 首帧 offscreen：未获得真实高度或锚点不可用时，浮层放到屏幕外，避免覆盖高亮的一瞬间。
  - 放置方向锁定：本次打开周期内锁定上/下放置，避免上下翻转（像素滞后阈值 `HYSTERESIS_PX=12`）。
  - 锚点抗抖：锚点像素变化小于 `STICKY_PX=3` 时沿用上次稳定值，降低细小抖动。

---

## Markdown 模式（HTML 预览）
- DOM 结构
  - 预览滚动容器内部包一层 `relative` wrapper；其下覆“内容容器”（渲染 HTML）与“overlay 层”（`absolute inset-0 pointer-events-none`）。
  - 浮层 Portal 到 overlay 节点下（非 body），防止 innerHTML 重建带来层级/引用抖动。
- 锚点来源（优先级）
  1) 命中高亮元素（`[data-mark-id]`）的 `getBoundingClientRect()`。
  2) 备份 Range（点击或划选时保存 `cloneRange` 或 `selectNodeContents`）。
  3) 上一次有效的 `anchorRect`（避免某些帧算不到时闪断）。
- 左对齐
  - `left = containerRect.left + paddingLeft + leftTweak(2px)`；`width=max(1, right-left)`，保证与内容首列视觉对齐。
- 滚动跟随
  - `autoUpdate` + 监听滚动容器与 window（捕获）+ ResizeObserver；rAF 合批 `update()`，避免抖动。
- 划选→高亮（列级）
  - 渲染时为文本节点包裹 `span[data-sourcepos]`。
  - 划选松手：用 `Range` 的起止 DOM 点 + `data-sourcepos` 推进行列坐标（`posFromDomPoint`），得到精确的 `startLine/startColumn/endLine/endColumn`；
  - 新建/更新时 `selectedText` 按上述行列从原始 Markdown 文本截取，确保与服务端校验一致。
- 侧栏跳转
  - 只滚动定位（默认不自动开浮层，可配置）；刷新即处于 Markdown 预览也可即时 reveal。
- 关闭
  - 默认启用“严格点击外部关闭”：仅主键无位移单击、期间未发生 scroll/wheel/pointercancel，且点击不在浮层内/不在高亮上时才关闭；ESC 关闭统一支持。
- 首帧无闪烁
  - `hasAnchor && coordsReady` 就绪后再挂载/显现；未就绪时隐藏到屏幕外并透明，杜绝 (0,0)/顶部闪烁。

---

## 配置项（默认值）
- `topPadLinesEditor`: 3（Editor 侧栏跳转置顶预留行数）。
- `flipThreshold/offset`: 8px（浮层与锚点间距）。
- `leftTweak`: 2px（首列对齐微调）。
- `stickyPxEditor`: 3（Editor 锚点抗抖阈值）。
- `hysteresisPxEditor`: 12（Editor 上/下放置方向滞后）。
- `autoOpenOnJumpMarkdown`: false（Markdown 侧栏跳转后是否自动打开浮层）。

> 以上大多在前端常量或组件参数中体现：
> - constants：`FLOATING_OFFSET=8`、`ANCHOR_LEFT_TWEAK=2`
> - Editor 放置策略：见 `editor-panel.tsx` 中 `STICKY_PX/HYSTERESIS_PX`

---

## 验收用例
- 首次点击高亮（两模式）：浮层在高亮附近出现，无顶部/左上角闪烁。
- 滚动跟随（两模式）：滚动时浮层稳定跟随，不会关闭/漂移。
- Markdown 划选→新建：新高亮范围与选择文本完全一致（列级）。
- 侧栏跳转：
  - Editor：只滚动定位、无蓝色系统选区重叠、黄色高亮可见。
  - Markdown：滚动定位到可视区域（通常置顶），默认不自动开浮层（可配置）。
- 关闭：ESC 生效；Editor 支持点击外部关闭；Markdown 严格判定的外点关闭生效。
- 边界：上方空间不足放下方，左右不溢出；超长文件/分页加载跳转稳定；换行开启/关闭下均稳定。

---

## 与代码实现的映射（关键文件）
- Editor（Monaco）
  - 查看器：`packages/web/src/components/editor/MonacoViewer.tsx`
  - 面板与浮层：`packages/web/src/features/explorer/components/main-area/editor-panel.tsx`
- Markdown 预览
  - 渲染与事件：`packages/web/src/components/editor/MarkdownPreview.tsx`
  - 浮层定位 Hook：`packages/web/src/components/editor/use-floating-annotation.ts`
  - 对齐工具：`packages/web/src/components/editor/utils.ts`
- 样式
  - 高亮：`packages/web/src/styles/globals.css`、`packages/web/src/styles/monaco-overrides.css`

---

## 常见问题与建议
- 工具条/容器高度变化是否影响定位？
  - Markdown：overlay 与 autoUpdate/ResizeObserver 组合，会在下一帧更新，无需额外处理。
  - Editor：当容器几何变化时，在下一次滚动/交互会重新计算锚点。必要时可在容器上加 ResizeObserver 主动触发一次复算（可选增强）。
- 端点列语义：建议统一为 endColumn “exclusive”。前后端按一致语义处理，避免整行高亮或 verify 误删。

以上规范为批注交互的 SSoT，未来改动需同步更新本文并在实现中维持两模式的隔离与一致性。

---

## 附录：Editor（Monaco）跳转实现细节与伪代码（融合自 annotation-jump.md）

本附录补充 Editor 侧“侧栏跳转 → 置顶与选区”的详细流程与注意事项。

1) 统一跳转通道
- 同片段：不重载；在现有模型上“先滚后选”一次完成。
- 跨片段：仅调整分页起点并设置 `pendingJump`；等待 onLoaded 后再统一 reveal（避免滚两次）。
- 同一范围重复点击：不滚动，仅更新选区/浮层，避免闪烁。

2) 偏移映射与拼接
- 绝对行 → 模型行：`rel = clamp(abs - offsetStart + 1, 1..modelLineCount)`；其中 `offsetStart` 必须使用服务端“真实返回”的 `startLine`。
- 向上拼接：在模型首行插入上一片，更新 `offsetStart = prev.startLine`；向下拼接更新 `endAbs`。

3) 定位算法（先滚后选）
- 计算：
  - `sRel = max(1, clamp((startAbs - offsetStart + 1), 1..N) - topPad)`
  - `eRel = clamp((endAbs - offsetStart + 1), 1..N)`
  - `selRange = Range(rawRelStart, startCol??1, eRel, endCol??lineEnd(eRel))`
  - `revRange = Range(sRel, 1, sRel, 1)`
- 顺序：先 `revealRangeNearTop(revRange, Immediate)`，下一帧 `setSelection(selRange)`，40–60ms 后若仍不可见则 `revealRangeInCenter(selRange, Immediate)` 兜底。
- 顶部留白：`topPadLines=3`（可调）。
- 去重：若与上次 key 相同且仍可见，仅更新选区不滚动。

4) 自动拼接抑制
- 跳转期间：`isJumping=true`；onDidScroll 不做 nearTop/nearBottom 拼接。
- 跳转后 400ms 内：`suppressAutoLoadUntil = now+400ms`，进一步防抖。

5) wrap 注意
- wrap=on 时优先 `revealRangeNearTop/Center(Immediate)`，减少像素级滚动误差；必要可适当增大 `topPadLines`。

伪代码（同片段即时定位）
```ts
function jumpTo(absStart, absEnd, startCol?, endCol?) {
  const rawRel = clamp(absStart - offsetStart + 1, 1, modelLineCount)
  const sRel = Math.max(1, rawRel - topPad)
  const eRel = clamp(absEnd - offsetStart + 1, 1, modelLineCount)
  const selRange = range(rawRel, startCol ?? 1, eRel, endCol ?? lineEnd(eRel))
  const revRange = range(sRel, 1, sRel, 1)
  if (sameAsLast(selRange) && isVisible(selRange)) {
    setSelection(selRange)
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

伪代码（跨片段加载）
```ts
onClick(ann) {
  pendingJump = ann
  if (!inCurrentChunk(ann)) {
    startLine = centerAround(ann.startLine)
  } else {
    jumpTo(ann.startLine, ann.endLine, ann.startColumn, ann.endColumn)
    pendingJump = null
  }
}

onLoaded(data) {
  offsetStart = data.startLine
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
