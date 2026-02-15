#!/usr/bin/env bun

import { runWorkspaceTests } from './commands/run-tests';
import { runCoreIntegrationTestsCommand } from './commands/test-integration';
import { runMnetE2ECommand } from './commands/mnet-e2e';
import { runMnetMeshCommand } from './commands/mnet-mesh';
import { runBaselineCommand } from './commands/benchmark-baseline';
import { runHttpBenchmarkMatrixCommand } from './commands/http-benchmark-matrix';
import { runBenchmarkPackCommand } from './commands/benchmark-pack';
import { runTypecheckMatrixCommand } from './commands/ts-matrix';
import { runReliabilityCommand } from './commands/reliability-run';
import { runPreflight } from './e2e/preflight';
import { runE2E } from './e2e/run';
import { assertE2E } from './e2e/assert';
import { cleanupE2E } from './e2e/cleanup';
import { runFullE2EWithCleanup } from './e2e/full';
import { readRuntimeState } from './e2e/lib';
import { resolveWorkspaceRoot } from './utils/test-artifacts';

type ParsedCli = {
  workspaceRoot: string;
  command: readonly string[];
};

const KNOWN_DOMAINS = ['test', 'e2e', 'bench', 'reliability'] as const;

const isKnownDomain = (value: string): boolean =>
  KNOWN_DOMAINS.includes(value as (typeof KNOWN_DOMAINS)[number]);

const printHelp = (): void => {
  console.log(`
Meristem Tooling CLI

Usage:
  tooling [--workspace-root <path>] <domain> <action> [...options]

Domains:
  test        workspace | integration-core | mnet-e2e | mnet-mesh
  e2e         preflight | run | assert | cleanup | full
  bench       baseline | http-matrix | pack | ts-matrix
  reliability run

Compatibility (deprecated aliases for one transition round):
  test integration      -> test integration-core
  bench http            -> bench http-matrix
  bench typecheck       -> bench ts-matrix
`);
};

const parseCli = (argv: readonly string[]): ParsedCli => {
  const args = [...argv.slice(2)];
  let workspaceRoot = process.env.MERISTEM_WORKSPACE_ROOT ?? resolveWorkspaceRoot();

  while (args.length > 0) {
    const token = args[0];
    if (token !== '--workspace-root') {
      break;
    }
    args.shift();
    const value = args.shift();
    if (!value || value.length === 0) {
      throw new Error('--workspace-root requires non-empty path');
    }
    workspaceRoot = value;
  }

  /**
   * 兼容入口归一化：
   * - 场景 A：直接执行脚本（`tooling bench baseline`）=> `argv.slice(2)` 即标准命令。
   * - 场景 B：`bun -e "import '.../cli'" bench baseline` => 第一个域名会落在 `argv[1]`，需要补回。
   * - 场景 C：工作区脚本采用桥接前缀（`tooling bench baseline`）时，允许显式 `tooling` 前缀并去除。
   *
   * 这样做是为了让主仓/子仓/CI 三种调用方式使用同一份 CLI 逻辑，避免因 argv 形态差异导致误判。
   */
  let normalizedCommand = [...args];
  const argvFirst = argv[1];
  if (argvFirst && (isKnownDomain(argvFirst) || argvFirst === 'tooling')) {
    const firstToken = normalizedCommand[0];
    const shouldRestoreFirstToken =
      firstToken !== undefined && !isKnownDomain(firstToken) && firstToken !== 'tooling';
    if (shouldRestoreFirstToken) {
      normalizedCommand = [argvFirst, ...normalizedCommand];
    }
  }
  if (normalizedCommand[0] === 'tooling') {
    normalizedCommand = normalizedCommand.slice(1);
  }

  return {
    workspaceRoot,
    command: normalizedCommand,
  };
};

const run = async (): Promise<void> => {
  const parsed = parseCli(process.argv);
  process.env.MERISTEM_WORKSPACE_ROOT = parsed.workspaceRoot;

  let [domain, action, ...rest] = parsed.command;
  if (!domain || domain === '--help' || domain === '-h' || domain === 'help') {
    printHelp();
    return;
  }

  /**
   * 兼容别名映射：
   * - 允许旧入口短名继续运行一轮，输出 deprecation 提示并映射到标准动作名。
   * - 失败策略是“明确失败而非静默忽略”，防止 CI 误以为命令成功。
   */
  if (domain === 'test' && action === 'integration') {
    console.warn('[tooling] deprecated: `test integration` -> use `test integration-core`');
    action = 'integration-core';
  }
  if (domain === 'bench' && action === 'http') {
    console.warn('[tooling] deprecated: `bench http` -> use `bench http-matrix`');
    action = 'http-matrix';
  }
  if (domain === 'bench' && action === 'typecheck') {
    console.warn('[tooling] deprecated: `bench typecheck` -> use `bench ts-matrix`');
    action = 'ts-matrix';
  }

  if (domain === 'test' && action === 'workspace') {
    const code = await runWorkspaceTests();
    process.exit(code);
  }
  if (domain === 'test' && action === 'integration-core') {
    await runCoreIntegrationTestsCommand(rest);
    return;
  }
  if (domain === 'test' && action === 'mnet-e2e') {
    await runMnetE2ECommand(rest);
    return;
  }
  if (domain === 'test' && action === 'mnet-mesh') {
    await runMnetMeshCommand(rest);
    return;
  }
  if (domain === 'e2e' && action === 'preflight') {
    const result = await runPreflight();
    console.log('[e2e:preflight] ok');
    console.log(`[e2e:preflight] mongo=${result.mongoUri}`);
    if (result.busyPorts.length > 0) {
      console.log(`[e2e:preflight] busy_ports=${result.busyPorts.join(',')}`);
    } else {
      console.log('[e2e:preflight] busy_ports=none');
    }
    return;
  }
  if (domain === 'e2e' && action === 'run') {
    await runE2E();
    const state = readRuntimeState();
    console.log('[e2e:run] ok');
    console.log(`[e2e:run] core_pid=${state.pids.core ?? 'none'}`);
    console.log(`[e2e:run] client_pid=${state.pids.client ?? 'none'}`);
    return;
  }
  if (domain === 'e2e' && action === 'assert') {
    await assertE2E();
    console.log('[e2e:assert] ok');
    return;
  }
  if (domain === 'e2e' && action === 'cleanup') {
    await cleanupE2E();
    console.log('[e2e:cleanup] ok');
    return;
  }
  if (domain === 'e2e' && action === 'full') {
    await runFullE2EWithCleanup();
    return;
  }
  if (domain === 'bench' && action === 'baseline') {
    await runBaselineCommand(rest);
    return;
  }
  if (domain === 'bench' && action === 'http-matrix') {
    await runHttpBenchmarkMatrixCommand(rest);
    return;
  }
  if (domain === 'bench' && action === 'pack') {
    await runBenchmarkPackCommand(rest);
    return;
  }
  if (domain === 'bench' && action === 'ts-matrix') {
    await runTypecheckMatrixCommand(rest);
    return;
  }
  if (domain === 'reliability' && action === 'run') {
    await runReliabilityCommand(rest);
    return;
  }

  printHelp();
  throw new Error(`unknown command: ${[domain, action].filter(Boolean).join(' ')}`);
};

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[tooling] failed: ${message}`);
  process.exit(1);
});
