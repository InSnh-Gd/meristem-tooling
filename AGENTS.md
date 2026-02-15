# Meristem Tooling Agent Guide

## 目标
- 本仓负责测试/基准/E2E 编排，不承载业务运行时核心逻辑。
- 通过 `MERISTEM_WORKSPACE_ROOT` 指向主工作区，驱动 `meristem-core/client/shared`。
- 承接跨仓验证责任：凡需跨进程或跨仓协同（Core+Client+NATS+Mongo）的测试，优先落到本仓。

## 测试分层边界
- 不承接业务仓纯单元测试（应留在 `meristem-core` / `meristem-client` / `meristem-shared`）。
- 重点承接：
  - 端到端流程（join/task/result/plugin lifecycle）
  - 跨仓集成场景（协议联调、契约回归）
  - 基准、可靠性与故障注入
- 新增测试前先判断是否“单仓即可验证”；若否，放入 tooling。

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
- `tooling test mnet-e2e`
- `tooling test mnet-mesh`
- `tooling e2e preflight|run|assert|cleanup|full`
- `tooling bench baseline|http-matrix|pack|ts-matrix`
- `tooling reliability run`
- 兼容别名（仅保留一轮并输出 deprecation 提示）：
  - `tooling test integration` -> `tooling test integration-core`
  - `tooling bench http` -> `tooling bench http-matrix`
  - `tooling bench typecheck` -> `tooling bench ts-matrix`

## 测试产物目录约定
- 默认测试产物根目录：`<MERISTEM_WORKSPACE_ROOT>/meristem-test-output`
- 可选覆盖：`MERISTEM_TEST_ARTIFACT_ROOT`（相对路径按 workspace root 解析，绝对路径直用）
- 目录命名要求：默认生成目录统一使用 `meristem-test*` 前缀，便于清理与归档
