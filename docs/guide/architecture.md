# 架构与目录（已实现）

概览
- 后端：Rust/Axum 二进制 `ailoom-server`，静态托管前端并提供 `/api/*`。
- 领域库：多 crate 解耦（core/fs/store/stitch）。server 仅组装路由与调用库能力。
- 前端：React + Vite + Tailwind v4 + shadcn/ui + Monaco（只读/可选全量编辑）。
- 存储：SQLite（WAL、busy_timeout），默认 `~/ailoom/ailoom.db`，失败回退为项目根 `.ailoom/ailoom.db`。
- 分发：`npx ai-loom` 跨平台封装，按平台选择对应二进制子包运行。

## WS 架构总览（PUSH + PULL）

- 目标：保存后 ≤1s 内页面必然纠正；单/多标签一致；弱网/后台 Tab 也能自愈。
- 思路：同时具备“推送（PUSH）”与“拉取补偿（PULL）”，并用“单写者（send+flush+超时）”保证“真的写出去”。

```
  业务/监听         Hub(广播)            Ring(事件环)        Forwarder(转发)         Writer(单写者)         浏览器WS
  ---------   ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐   ┌───────────┐
  file.save → │ broadcast(file/*)│ → │ 追加带 eventId   │ → │ 分流：priority   │ → │ send+flush(超时) │ → │ 事件处理   │
  fswatch  →  │ receivers/去重    │   │ 支持 resume/tail │   │ file 队列/ tree  │   │ 成功才记 lastSent │   │ 缓存失效   │
              └──────────────────┘   └──────────────────┘   └──────────────────┘   └──────────────────┘   └───────────┘
                                                       ↑                                         │
                                                       └──────── Pump(每~200ms从 ring 拉增量) ───┘
                                                    Supervisor(对比 hub.lastEventId vs lastSent，落后~1000ms→close-first)
```

- 模块分工（后端）：
  - Hub：像“电台发射塔”，负责广播与轻量去重，打印 receivers/ring 观测。
  - Ring：最近 N 条事件的“播放单”，提供 `events.resume(after/tail)` 与 PULL 拉取。
  - Forwarder：每连接一个，订阅 Hub 后按“priority/file/tree”分流投递给 Writer。
  - Writer：唯一写出任务；所有帧 `send+flush`，失败立刻 close-first（促重连+resume）。
  - Pump：按固定间隔从 Ring 拉取“落下的事件”，确保 PUSH 失效时 ≤1s 也能补上。
  - Supervisor：仅比较“Hub 最新事件 id”与“该连接最后一次成功写出的 id”，落后超阈值触发自愈。

- 三路通道（写出优先级）：
  - priority（mpsc，cap≈64）：RPC 响应、`session.resync` 等关键帧（不丢、优先写）。
  - file（mpsc，cap≈256）：`file.changed`、`annotations.*`（按序、不可丢）。
  - tree（watch keep‑latest）：`tree.changed`（只保留最新，避免刷屏）。

- 前端：
  - 连接、重连与增量恢复：`events.resume(after/tail=128)`。
  - 订阅：根目录、file prefix:''、选中文件 path；`file.changed` → 精确失效；`tree.changed` → 节流重建。
  - 后台 Tab：以 setTimeout 刷新兜底（rAF 在后台不执行）。

更多细节与术语“接地气”解释，见：`docs/guide/ws-overview.md`（含关键时序、术语、开关说明）。

### WS 架构（Mermaid）

```mermaid
flowchart LR
  subgraph Client[浏览器]
    BWS[WS 客户端\n订阅/重连\nresume(tail=128)]
  end

  subgraph Server[后端]
    FS[FS Watcher\n文件监听合批]
    SAVE[业务写入\nfile.save]
    HUB((Hub\n广播/去重/观测))
    RING[(Ring\n事件环/增量)]

    subgraph Conn[单个连接]
      FWD[Forwarder\n订阅过滤/事件分流]
      WR[Writer(单写者)\nsend+flush+超时]
      SUP[Supervisor\n游标比较/自愈]
    end
  end

  %% 产生事件
  SAVE -->|file.changed| HUB
  FS -->|file.changed / tree.changed| HUB

  %% 入环（带 eventId）
  HUB -->|入环(多数业务事件)| RING

  %% PUSH 转发
  HUB -->|PUSH 广播| FWD
  FWD -->|priority/file/tree 三路| WR
  WR -->|帧写出| BWS

  %% PULL 补偿
  RING -.->|Pump 周期拉取增量| WR

  %% 自愈与重连
  HUB -->|lastEventId| SUP
  WR -->|lastSentEventId| SUP
  SUP -->|resync(可选) + close-first| BWS
  BWS -->|重连 + events.resume(after/tail)| HUB

  classDef strong fill:#eef,stroke:#447;
  class HUB,RING,WR strong;
```

### 保存一次的关键时序（Mermaid）

```mermaid
sequenceDiagram
  participant E as Editor/前端
  participant S as Server
  participant H as Hub
  participant R as Ring
  participant F as Forwarder
  participant W as Writer
  participant C as Client/WS

  E->>S: file.save(path, content)
  S->>H: broadcast(file.changed)
  Note right of H: 大多数业务事件入 Ring（生成 eventId）
  H->>R: append(event)
  H-->>F: PUSH(file.changed)
  F-->>W: 分流到 file 队列
  W-->>C: send + flush（成功）
  C-->>E: 收到 file.changed → 刷新视图

  alt PUSH 被节流/阻塞
    R-->>W: Pump 每~200ms 拉取 >lastSent 的增量
    W-->>C: send + flush（成功）
  end

  alt 长时间落后（~1000ms）
    S-->>W: Supervisor 发现 hub.lastEventId > lastSent
    S-->>C: （可选）session.resync
    S--xC: 关闭连接（close-first）
    C-->>S: 重连
    C->>S: events.resume(after/tail=128)
    S-->>C: 增量补发 events
  end
```


工作区结构（关键路径）
- `packages/rust/ailoom-server`：Axum 服务路由与静态资源托管
- `packages/rust/crates/ailoom-core`：类型（DirEntry、FileChunk、Annotation等）
- `packages/rust/crates/ailoom-fs`：根目录沙箱、忽略规则合并、分页读取、二进制探测、原子写与冲突检测
- `packages/rust/crates/ailoom-store`：SQLite 迁移、CRUD、导入/导出合并
- `packages/rust/crates/ailoom-stitch`：模板（concise/detailed）、中间省略、统计
- `packages/web`：前端应用（Vite + React + Tailwind + shadcn/ui）
- `packages/npm/ai-loom`：CLI 入口与平台二进制选择

路由与静态托管
- API：`/api/tree` `/api/file` `/api/file/full` `PUT /api/file` `/api/annotations*` `/api/stitch`
- 静态：默认将 `packages/web/dist` 挂载到 `/`（可通过 `--no-static` 关闭以配合 Vite Dev）
- 绑定：仅 `127.0.0.1`，启动时输出 `AILOOM_PORT=<port>`。

实现差异（对齐方向）
- `/api/file` 返回体字段当前为 snake_case，前端按 camelCase 使用（见 `fs-and-limits.md` 的对齐说明）。
