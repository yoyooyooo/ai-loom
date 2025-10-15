# 检索、排序与 Token 预算

## 1. 检索流程

1) 解析查询：关键词、路径、符号名、方法/路由、标签
2) 结构化优先：先查结构化索引（items/edges），必要时再全文（FTS）
3) 合并结果：去重，拉通不同 kind 的候选
4) 评分排序：相关度（字段匹配）+ 新鲜度（updatedAt）+ 优先级（kind 权重）

## 2. 预算配置（Profile）

- `minimal`：仅 id+name+anchor+summary，不含原文
- `concise`：再加 signature/fields 与少量上下文
- `detailed`：包含关键代码片段/配置片段（受最大 Token 控制）

示例：
```json
{
  "annotation": { "weight": 4, "maxTokens": 500 },
  "api_route": { "weight": 3, "maxTokens": 400 },
  "code_symbol": { "weight": 3, "maxTokens": 400 },
  "project_fact": { "weight": 2, "maxTokens": 200 },
  "task_playbook": { "weight": 1, "maxTokens": 150 }
}
```

## 3. 拼接策略（Stitcher）

- 结构大纲：分区块输出，每块内按文件/位置排序
- 冲突处理：同一锚点的多条上下文合并，保留最具体指令
- 截断策略：
  1) 优先摘要化长片段；
  2) 仍超限则只保留锚点与关键字段；
  3) 透出 `id` 方便客户端二次拉取详情。

## 4. 估算与监控

- estTokens：每条 ContextItem 存储估算 Token 值（按字段长度与语言分布估算）
- 拼接前预估总量，超预算时给出建议（减少某类或切换 profile）

