# 006 — CORS 与 WS Origin 收敛（默认安全）

- 背景：默认绑定 127.0.0.1 风险低，但 REST CORS/WS Origin 建议更收敛（白名单）。
- 目标：
  - REST：默认仅同源/localhost，支持白名单 env；
  - WS：默认仅同源/白名单 Origin，提供 `AILOOM_WS_ALLOWED_ORIGINS`；开发保留 `ALLOW_ANY` 快捷开关。
- 验收：
  - 在 `docs/guide/architecture.md` 增补配置说明与例子；本地验证行为符合预期。
- 关联：`docs/guide/architecture.md`
