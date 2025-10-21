# 架构改进需求清单（第一批）

目的：将近期在代码评审/架构评估中识别的“需要关注/可改进点”转化为可执行的需求清单，以安全、稳定、一致为优先，分阶段推进。

- 范围：`packages/rust/*`、`packages/web/*`、相关文档
- 术语：WS=WebSocket；RQ=React Query；HUB=服务端广播枢纽；Ring=事件环
- 优先级定义：P0（安全/一致性，优先）> P1（体验/工程质量）> P2（可运维/演进）

## P0（安全/一致性）

### SEC-01 CORS 与 WS Origin 默认收敛
- 背景：当前 REST CORS 允许 Any、WS Origin 默认放开，虽仅绑定 127.0.0.1 风险较低，但建议默认更收敛。
- 目标：
  - REST：默认仅允许同源（或 127.0.0.1/localhost），支持通过环境变量配置白名单。
  - WS：默认仅允许同源/白名单 Origin，提供 `AILOOM_WS_ALLOWED_ORIGINS`；保留 `AILOOM_WS_ALLOW_ANY_ORIGIN=1` 仅限开发。
- 验收：
  - 未设置任何 env 时，同源可访问；跨源默认 403。
  - 设置白名单后，名单内可访问、名单外 403；开发模式保留“允许任意”的快速开关。
  - README/docs 更新配置说明（含例子）。

### ERR-02 错误码 SSoT（REST/WS 一致化对照）
- 背景：REST/WS 在能力不足时分别使用 `HTTP_413` 与 `MESSAGE_TOO_LARGE`，映射已基本统一，但缺少集中 SSoT 与校验。
- 目标：
  - 在文档中固化“错误码对照表”（REST⇄WS），约束新接口复用；前端统一用 `toHttpError/wsPrefer` 包装。
  - 代码审查项：新增方法的错误码必须进入表格并附带测试（至少单元/冒烟）。
- 验收：
  - 新增 `docs/guide/api-errors.md` 或在现有 WS/HTTP 指南处新增章节，包含常见错误码、语义与示例。
  - 后端新增/改动方法的 PR 模板需引用该表；前端对应路径通过该包装函数处理。

## P1（体验/工程质量）

### NAM-03 组件命名统一为 kebab-case（通用编辑器）
- 背景：`packages/web/src/components/editor` 下仍存在 `MonacoViewer.tsx`、`MarkdownPreview.tsx`、`MonacoEditorFull.tsx` 等 PascalCase 文件名，违背约定。
- 目标：
  - 统一重命名为 `monaco-viewer.tsx`、`markdown-preview.tsx`、`monaco-editor-full.tsx`；修复所涉 import。
- 验收：
  - 该目录及引用处不再存在 PascalCase 文件名；构建/运行正常。

### API-04 DirEntry.type 统一小写输出（前后端一致化）
- 背景：前端类型允许 `"file"|"dir"|"File"|"Dir"` 两种形态；建议后端统一输出小写，前端保留兼容期后去除大小写混用。
- 目标：
  - 后端 `ailoom-fs::list_dir` 输出统一为 `"file"/"dir"`；前端暂保留兼容分支，立刻容错。
  - 第二阶段移除前端对 `"File"/"Dir"` 的分支逻辑。
- 验收：
  - 新旧服务端均可运行（兼容期）；切到统一输出后，前端不再依赖大小写混用。

### EDIT-05 编辑器外部变更提示升级（digest/冲突语义强化）
- 背景：全量编辑模式下若收到外部变更事件，现有提示基于内容相等/不等；可增强 digest 对账提示，降低误会。
- 目标：
  - 在全量编辑模式下维护“上次保存 digest”，收到 `file.changed` 时：
    - 若编辑器内容未改动（与本地缓存一致），自动刷新并 toast 成功；
    - 若有本地改动，toast 提示“外部已变更（digest 不同）”，提供“刷新/忽略”两按钮。
- 验收：
  - 手工与外部修改流程均符合上述行为；无误覆盖。

### TREE-06 文件树重建逻辑抽象与虚拟化（基础）
- 背景：文件树组件内部既订阅 `tree.changed/file.changed` 又依赖 Query 失效；逻辑已做节流，但重建流程可抽象，且后续需要虚拟列表。
- 目标：
  - 抽象“订阅触发 → 展开态保持 → 局部刷新”的重建 util，降低组件复杂度；
  - 引入虚拟滚动（如 react-virtual/virtua），在大目录下保持流畅。
- 验收：
  - 在 1w+ 节点模拟数据下滚动/展开流畅（>50 FPS 经验值），订阅触发刷新不抖动。

### TST-07 关键路径测试补齐
- 背景：WS 客户端/invalidators 有基础测试；建议补齐保存冲突链路与注解增删改的前端最小用例，后端服务保持现有单测。
- 目标：
  - 前端：
    - `saveFile` 冲突提示（CONFLICT）
    - invalidators 在 `file.changed/tree.changed/annotations.*` 三类事件下的缓存一致性
  - 后端：
    - 已有 `verification.rs` 单测覆盖“找不到选区删除”的关键路径；新增 1 个 annotation 更新用例（可选）。
- 验收：
  - 新增测试可稳定重现并通过；CI 绿。

### PERF-08 read_file_chunk total_lines 计算策略评估（研究项）
- 背景：为计算 `total_lines` 会遍历全文；大文件临界值附近可能增加 IO。
- 目标：
  - 评估替代方案（如惰性总行数、近似估算、轻量端点 `file.head`）与收益；优先维持正确性与简洁性。
- 验收：
  - 输出研究结论（文档/对比），如需更改再开实施任务。

## P2（可运维/演进）

### HUB-09 Ring/广播参数化与文档化
- 背景：已支持 `AILOOM_WS_RING_CAP`、`AILOOM_WS_DEDUP_MS` 等；需集中文档化与默认值说明。
- 目标：
  - 在 `docs/guide/ws-overview.md` 增补“配置与调优”章节（ring 容量、去重窗口、pump 周期、监督器开关）。
- 验收：
  - 文档落地；默认行为与文档一致；调参可复现实验结果。

### FSW-10 监听风暴策略与指南
- 背景：已支持合批/节流与 `.gitignore/.ailoomignore`；需明确“风暴”场景下的调优建议与上限影响。
- 目标：
  - 文档化 `AILOOM_FSWATCH_*` 参数（批量窗口/最大 impactedPaths/force_resync 等）与推荐值；强调被截断时前端粗粒度刷新策略。
- 验收：
  - 指南可复现“风暴→稳定”路径；面板指标（ring/droppedLowPri/tree.batches）能反映优化效果。

### WS-11 多连接/注册表（Registry）设计预案（文档）
- 背景：Phase 1 单连接足够；未来可按域拆分 QoS（如 fs/stitch）。
- 目标：
  - 在 `docs/specs/ws/client.md` 中保留 Registry 章节（已存在方案草案），明确何时触发拆分、如何选路与 HMR 安全。
- 验收：
  - 仅文档与接口预留，不改现状；后续按需落地。

### SEC-12 速率限制/简单鉴权（预研）
- 背景：如需走内网远端或暴露端口，建议具备最小限度的限流与鉴权能力。
- 目标：
  - 预研：Axum/tower 中间件速率限制方案、WS 连接级限数；可选简易 token（env/cli 配置）。
- 验收：
  - 形成预研文档与 PoC 建议；真正实施另起任务。

---

## 里程碑建议
- M1（安全与一致）：SEC-01、ERR-02、NAM-03、API-04
- M2（体验与质量）：EDIT-05、TREE-06、TST-07
- M3（可运维与演进）：HUB-09、FSW-10、WS-11、SEC-12（预研）

## 提交与验证
- 每项需求提交需包含：变更概述、动机与方案、验证步骤（含 just/cargo/pnpm 命令）、必要截图或日志、关联 Issue；保持小而可审。
- 严格遵守命名/目录规范与 Query Key 规范；通过现有 pre-commit 与 CI 检查。
