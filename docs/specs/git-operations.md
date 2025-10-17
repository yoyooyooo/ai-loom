# Git 操作（状态：未实现）

说明：本规范对应的 CLI/API 能力尚未集成到服务；此处仅保留目标简述：以 Git CLI 为执行层，提供“未提交文件筛选”等只读/轻写能力。

已实现关联能力：无；开发参考 SSoT 的安全约束（../guide/security.md）。

规划中的接口（示例）：
- GET `/api/git/uncommitted?root=&paths=` → `{ files: string[] }`

实现要点：
- 解析 `git status --porcelain`；遵从忽略规则；路径白名单；错误回退与跨平台一致性。
