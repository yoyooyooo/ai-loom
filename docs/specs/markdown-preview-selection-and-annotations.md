# Markdown 预览：代码块划选与批注交互规范 v1

## 背景
- 当前在 Markdown 预览模式下：
  - 代码块区域（含黑色背景）难以/无法进行文本划选；
  - 系统选区（蓝色/高亮）在部分情况下不可见；
  - 单击批注高亮可跳转定位是正常的，但“划选后自动弹出批注浮层”并不稳定。
- 初步排查显示问题根因来源于两类：
  1) 事件层级与阻断（mousedown 捕获/阻止默认等）与“点击打开批注”的交互冲突；
  2) Portal 承载层（overlay）覆盖内容层，导致浏览器绘制的原生选区不可见。

本规范定义一个可实现、可验证、可回滚的解决方案，确保在预览模式下具备一致的文本选择与批注体验。

## 目标与非目标
### 目标
- 在 Markdown 预览的所有文本区域（段落、内联代码、代码块）可正常“拖拽划选 + 复制”。
- 代码块在深色背景下，划选高亮可明显可见（默认依赖系统选区；必要时以 CSS 增强）。
- 划选结束时触发“创建批注”浮层，精确映射源文位置（行/列范围与选中文本）。
- 单击既有批注高亮（高亮片段）时，打开“编辑批注”浮层；与“划选”不冲突。
- 滚动/窗口变化时，批注浮层稳定跟随（无明显抖动/错位）。

### 非目标
- 不在本规范中引入 Markdown 内容的语法高亮主题变更或渲染器替换。
- 不涉及后端批注数据模型变更（沿用现有 `startLine/endLine/startColumn/endColumn/selectedText`）。
- 不实现移动端长按选词的专项优化（可列为后续工作）。

## 术语
- 预览容器（Preview Scroll Container）：包裹 Markdown 内容的滚动容器。
- 内容主节点（Preview Host）：渲染 Markdown 的根元素（`.prose`）。
- Portal 承载层（Overlay Host）：用于承载批注浮层 Portal 的节点。
- 高亮片段（Mark Span）：带有 `data-mark-id` 的内联高亮，类名 `.ailoom-anno-inline`。
- 源位置属性：`data-sourcepos="sL:sC-eL:eC"` 映射源文本的起止行列。

## 交互规则
1) 文本选择与点击优先级
- 仅当页面不存在非折叠选区（`window.getSelection().isCollapsed === true`）时，单击高亮片段才触发“打开批注”。
- 若存在非折叠选区，则“点击打开批注”应被忽略（优先保留用户的文本选择体验）。

2) 划选结束触发
- 在 `mouseup` 上读取选区：将选区端点映射到最近的 `data-sourcepos` 元素，计算 `startLine/endLine/startColumn/endColumn` 与 `selectedText`。
- 计算 `anchorRect`：优先使用选区 Range 的首个 `ClientRect` 作为浮层锚点。
- 触发 `onSelectionChange({ startLine, endLine, startColumn, endColumn, selectedText, anchorRect })`。

3) 打开既有批注
- 在无选区时，单击 `.ailoom-anno-inline` 或携带 `data-mark-id` 的元素：
  - 解析命中元素的 `data-sourcepos`；
  - 以命中元素的 `getBoundingClientRect()` 作为锚点（同时备份一个 Range 以容错）；
  - 触发 `onOpenMark(mark, anchorRect)`。

4) 关闭浮层（Markdown 预览内严格判定）
- 仅当一次“有效无位移点击”发生在浮层外部，且期间未发生滚动/滚轮，且点击目标也不在高亮元素上时，关闭浮层。
- `Escape` 键统一关闭浮层。

5) 选区可见性
- Portal 承载层不得以覆盖方式遮挡内容层；推荐：
  - `overlay` 作为“非覆盖”容器：`display: contents; pointer-events: none;`；
  - 或者将浮层 Portal 到 `document.body`，并以更高 `z-index` 显示。
- 默认依赖系统原生选区高亮；若深色背景下对比不足，可增补 `::selection`（非强制）。

## 结构与样式
### DOM 结构（建议）
```
<div class="preview-scroll-container">
  <div class="preview-host prose ..."> ... 渲染后的 HTML（含 data-sourcepos）...</div>
  <div id="overlay-host" class="overlay-host">(作为 Portal 宿主，不覆盖内容)</div>
</div>
```

### 关键样式
- 选择权限：
  - `.prose, .prose * { user-select: text; }`
  - 禁止任何后代元素引入 `select-none`；若必须存在，则在代码块内以 `!important` 恢复。
- 高亮片段：
  - `.ailoom-anno-inline { background: rgba(255,214,102,.35); cursor: text; }`
- Overlay 承载层：
  - `display: contents; pointer-events: none;`（或直接 Portal 到 `body`）。

## 事件与状态（组件合约）
组件：`<MarkdownPreview />`
- Props：
  - `content: string`
  - `annotations?: { id?: string; startLine; endLine; startColumn?; endColumn? }[]`
  - `onSelectionChange?: (sel: { startLine; endLine; startColumn?; endColumn?; selectedText; anchorRect }) => void`
  - `onOpenMark?: (mark, anchorRect?) => void`
  - 可选锚点透出：`onAnchorElChange?`、`onAnchorRangeChange?`、`onContainerElChange?`、`onScrollElChange?`、`onOverlayElChange?`
- Ref：
  - `reveal(startLine: number, endLine: number)`：滚动定位到行区间可见。
- 监听：
  - `mouseup`：处理划选与 `onSelectionChange`
  - `click`（冒泡阶段）：处理 `onOpenMark`（前置“无选区”判定）
  - `keydown(Escape)`：关闭浮层（由父层统一）
  - 滚动/尺寸：由父层的 floating-ui autoUpdate 统一处理

## 边界与容错
- 选区跨多节点/多行：以端点行列计算，`selectedText` 以 Range 文本为准；若端点顺序反转，先归一化。
- 代码块行内软换行（wrap）不影响源行列映射；始终以 `data-sourcepos` 为准。
- 命中不可测量元素（首帧尚未渲染）：使用备份 Range 或最后一次有效 `anchorRect` 兜底。
- Safari 老版本对 `display: contents` 支持较差时：回退为 `portal: body` 方案。

## 性能
- 增量包装：仅对文本节点包裹 `span[data-sourcepos]`；高亮切分仅在命中时进行。
- 在浮层跟随中使用 `requestAnimationFrame`/`autoUpdate` 节流。

## 无障碍与可用性
- 浮层出现时将焦点移入并提供 `Esc` 关闭；
- 为批注按钮/表单提供可聚焦顺序与 ARIA 标签；
- 保持键盘选择（Shift+Arrow）可用。

## 验收标准（手工测试）
1) 代码块内：拖拽产生系统选区高亮；复制内容与所见一致。
2) 高亮片段上：拖拽可产生选区；单击（无选区）可打开编辑浮层。
3) 普通段落/内联代码：同样可划选并复制。
4) 划选后自动弹出“新建批注”浮层，坐标锚点贴近选区首段；
5) 滚动容器滚动、窗口尺寸变化：浮层位置稳定，无明显抖动；
6) Safari、Chrome、Edge（近 2 年版本）均通过；
7) 暗色主题下代码块选区清晰可辨（若关闭增强样式，也能看见系统选区）。

## 里程碑与拆分
- M1（结构落地）：
  - Overlay 不覆盖内容；click 优先级规则；取消任何 `mousedown` 阻断；
  - `mouseup` 映射行列并上报；Ref.reveal 能力保持。
- M2（浮层稳定）：
  - 引入/复用 floating-ui；滚动/尺寸 autoUpdate；锚点优先级（元素 > Range > 上次有效）。
- M3（兼容与细节）：
  - Safari 回退策略；聚焦/关闭规则；深色代码块可见性增强（可开关）。
- M4（验证与文档）：
  - 用例脚本与回归清单；开发文档与样例 Markdown（含代码块/内联代码/长内容）。

## 回滚策略
- 所有行为 behind feature flag（如 `MD_PREVIEW_FLOATING_V1`）；异常时可一键回退为旧逻辑。

## 开放问题
- 移动端交互（长按/气泡菜单）是否纳入 v1？
- 复杂多段联合高亮的统一锚点策略是否需要专用视觉（如虚线框）？

