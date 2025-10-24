# Implementation Plan: Chat 模块侧边栏整合

**Branch**: `005-chat-sidebar-refresh` | **Date**: 2025-10-25 | **Spec**: [/specs/005-chat-sidebar-refresh/spec.md](./spec.md)
**Input**: Feature specification from `/specs/005-chat-sidebar-refresh/spec.md`

**Note**: This template is filled in by the `/speckit.plan` command. See `.specify/templates/commands/plan.md` for the execution workflow.

## Summary

本次改造围绕 shadcn/ui 提供的多栏侧边栏 block，将其规范化为全局应用框架：首栏统一承载顶层模块导航（Chat、Explore 等），聊天模块沿用第二栏展示会话历史、第三栏聚焦当前会话消息；探索模块在第二栏内提供“文件/批注”双标签承载原 ActivityBar 的文件树与批注功能，并在不需要时关闭第三栏。计划在不破坏现有路由与状态管理的前提下重构 `AppShell`/`Sidebar` 相关组件、收编 ActivityBar 能力、复用既有历史列表与聊天面板，并提供配置化机制允许未来模块选择栏位数目。

## Technical Context

**Language/Version**: TypeScript 5.x + React 18 (Vite 构建链)
**Primary Dependencies**: shadcn/ui Sidebar 体系、TanStack Query、Zustand（chat/explorer stores）、Tailwind v4 设计令牌
**Storage**: 前端状态由 Zustand/React Query 缓存；会话数据通过现有后端 API 读取（无需新增持久化）
**Testing**: Vitest + React Testing Library（当前仓库未强制，但本计划默认以故事性手测为主并补充关键渲染用例）
**Target Platform**: Web 浏览器（桌面优先，需兼顾窄屏折叠）
**Project Type**: 单一前端应用（packages/web）
**Performance Goals**: 导航切换与会话恢复交互在 2 秒内完成（与规格成功指标一致）
**Constraints**: 遵守宪章第 3、5 条的前端命名与简洁原则；布局需在窄屏下自动折叠，禁止引入新的全局状态耦合
**Scale/Scope**: 现有双模块（Chat/Explore），需支持未来扩展至更多顶层模块

## Constitution Check

| 宪章条款 | 预检查结果 |
|----------|-------------|
| 1) 安全与沙箱边界 | ✅ 前端改造不影响后端沙箱策略 |
| 2) 读取优先 WS | ✅ 仅改造 UI 框架，不新增 API 调用模式 |
| 3) 前端架构与命名规范 | ✅ 复用现有别名与命名，新增文件保持 kebab-case / PascalCase |
| 4) 开发流程与工具链 | ✅ 使用既有 just dev 流程，计划中明确不触发额外构建 |
| 5) 简洁优先与可调试性 | ✅ 侧边栏配置化保持简单可调试，不引入多余抽象 |

> 当前门禁全部通过，无需在 Complexity Tracking 表中备案。

## Project Structure

### Documentation (this feature)

```text
specs/005-chat-sidebar-refresh/
├── plan.md              # 本实现计划
├── research.md          # Phase 0 产物
├── data-model.md        # Phase 1 产物
├── quickstart.md        # Phase 1 产物
├── contracts/           # Phase 1 产物：界面/状态契约
└── tasks.md             # Phase 2（/speckit.tasks）生成
```

### Source Code (repository root)

```text
packages/web/
├── src/
│   ├── app.tsx
│   ├── components/
│   │   └── app-sidebar.tsx
│   ├── features/
│   │   ├── chat/
│   │   └── explorer/
│   ├── routes/
│   └── styles/
└── vite.config.ts
```

**Structure Decision**: 保持单一前端项目结构，在 `packages/web/src` 内新增/重构组件与配置层；不拆分新的 package 或后端模块。

## Complexity Tracking

未触发宪章例外，无需记录额外复杂度。
