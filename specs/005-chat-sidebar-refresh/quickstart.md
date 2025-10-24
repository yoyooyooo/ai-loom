# Quickstart: Chat 模块侧边栏整合

## 前置条件
1. 安装依赖：`pnpm install`（首次运行）
2. 启动联动开发：`just dev-all`，或在两个终端分别运行 `just server-dev` 与 `just web-dev`
3. 确保 `VITE_API_BASE` 指向本地后端；默认 `http://127.0.0.1:8787`

## 验证步骤
1. **导航结构**：访问 `http://localhost:5173/chat`，确认首栏显示 Chat/Explore，并高亮 Chat。
2. **第二栏历史**：观察会话历史按时间倒序排列；在空数据环境下应出现“暂无历史”空态，恢复中条目展示“恢复中…”提示。
3. **第三栏消息面板**：点击历史后，第三栏展示对应消息记录，输入区/停止生成按钮正常工作，滚动自动定位到最新消息。
4. **跨模块切换**：点击 Explore 导航，确认 Explorer 页面维持原有布局，首栏高亮 Explore，返回 Chat 后历史与消息状态保持。
5. **响应式**：将窗口缩小至 < 768px，验证导航按钮收纳为抽屉，点击标题栏触发器可展开/收起 Sidebar。
6. **错误处理**：断网或模拟接口失败，确保第二栏出现错误提示与重试按钮。
7. **构建验证**：运行 `pnpm -C packages/web build`，确认产物构建成功（存在 chunk size 警告即可忽略）。

## 常见问题
- 若历史列表加载失败，请查看浏览器 Network 日志，确保 `GET /api/chat/conversations` 正常返回。
- 若第三栏未展示消息，确认 `chatActions.setConversationId` 在恢复流程中被触发（可使用 devtools）。
- 若窄屏下布局溢出，可检查 `useSidebar()` 折叠状态及 Tailwind 断点变量是否生效。
