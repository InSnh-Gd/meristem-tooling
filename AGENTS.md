# Meristem Tooling Agent Guide

## 目标
- 本仓负责测试/基准/E2E 编排，不承载业务运行时核心逻辑。
- 通过 `MERISTEM_WORKSPACE_ROOT` 指向主工作区，驱动 `meristem-core/client/shared`。

## 约束
- Runtime: Bun-only。
- TypeScript: strict，不允许 `any`。
- 默认主线：TS5 阻断；TS7 作为 preview 结果输出。

## 注释规范（Mandatory）
- 新增或重构复杂逻辑时，必须添加中文“块级注释”。
- 注释按“逻辑段”说明：做什么、为什么这么做、失败/降级如何处理。
- 禁止按单行逐条解释代码字面含义。

## 命令契约
- `tooling test workspace`
- `tooling test integration-core`
- `tooling e2e preflight|run|assert|cleanup|full`
- `tooling bench baseline|http-matrix|pack|ts-matrix`
- `tooling reliability run`
