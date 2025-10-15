# 结构化扫描与 AST 归一化

## 1. 目标

- 将源代码/配置/路由等信息转换为可被 LLM 高效消费的“结构化上下文”，以显著降低 Token 开销并提高检索精准度。

## 2. 语言与工具选型

- TypeScript/JavaScript：ts-morph + TypeScript Compiler API（优先）
- 多语言通用：tree-sitter（统一解析框架，按语言加载语法）
- 备选/基线：universal-ctags 生成符号索引（快速、粗粒度）

## 3. 归一化流程

1) 解析：从 AST/静态分析提取原始结构
2) 归一化：映射到标准化的 `CodeSymbol`/`ApiRoute`/`ConfigItem` 等模型
3) 丰富：关联文件路径、位置、导入/导出关系、调用图/引用计数
4) 摘要：为冗长片段生成可读摘要（规则优先，必要时调用本地 LLM/模板）
5) 存储：写入 Store 与关系表，建立倒排索引与邻接表

## 4. 产物（示例 Schema 摘要）

- CodeSymbol（函数）
```json
{
  "id": "symbol:src/api/routes.ts#getTree",
  "kind": "code_symbol",
  "language": "ts",
  "symbolType": "function",
  "name": "getTree",
  "filePath": "src/api/routes.ts",
  "location": { "startLine": 12, "endLine": 48 },
  "exported": true,
  "signature": "(root: string) => Promise<FileNode[]>",
  "doc": "返回给定根目录的文件树……",
  "imports": ["fast-glob"],
  "calls": ["fg", "normalizeTree"],
  "relations": [ { "type": "defines_route", "to": "api_route:GET /api/tree" } ]
}
```

- ApiRoute
```json
{
  "id": "api_route:GET /api/tree",
  "kind": "api_route",
  "method": "GET",
  "path": "/api/tree",
  "handler": "symbol:src/api/routes.ts#getTree",
  "validator": null,
  "produces": "application/json",
  "summary": "获取文件树",
  "filePath": "src/api/routes.ts",
  "location": { "startLine": 10, "endLine": 15 }
}
```

## 5. TypeScript 提取要点（ts-morph）

- 导出项扫描：`sourceFile.getExportedDeclarations()`
- 函数签名：`func.getParameters()/getReturnType().getText()`
- JSDoc：`func.getJsDocs()`
- 引用查找：`project.getLanguageService().findReferences()`
- 调用图（近似）：在函数体内遍历 `CallExpression`，收集标识符

## 6. tree-sitter 适配

- 适用于 Go/Java/Python/Rust 等语言，统一可解析语法树
- 通过 `query` 模式匹配函数/类/方法/路由注册等结构，映射到统一模型

## 7. 增量与监听

- 文件变更时只重建受影响文件的产物，并级联更新关系与索引
- 版本/哈希：基于（path+mtime+size+hash）判断是否需要重算

## 8. 敏感信息与脱敏

- 对可能包含密钥/PII 的配置与代码段进行静态检测，生成 `sensitivity` 标注并在对外暴露时脱敏或仅输出摘要

