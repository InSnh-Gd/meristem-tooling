#!/usr/bin/env bun

import { runWorkspaceTests } from './commands/run-tests';
import { runCoreIntegrationTestsCommand } from './commands/test-integration';
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

type ParsedCli = {
  workspaceRoot: string;
  command: readonly string[];
};

const printHelp = (): void => {
  console.log(`
Meristem Tooling CLI

Usage:
  tooling [--workspace-root <path>] <domain> <action> [...options]

Domains:
  test        workspace | integration-core
  e2e         preflight | run | assert | cleanup | full
  bench       baseline | http-matrix | pack | ts-matrix
  reliability run
`);
};

const parseCli = (argv: readonly string[]): ParsedCli => {
  const args = [...argv];
  let workspaceRoot = process.env.MERISTEM_WORKSPACE_ROOT ?? process.cwd();

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

  return {
    workspaceRoot,
    command: args,
  };
};

const run = async (): Promise<void> => {
  const parsed = parseCli(process.argv.slice(2));
  process.env.MERISTEM_WORKSPACE_ROOT = parsed.workspaceRoot;

  const [domain, action, ...rest] = parsed.command;
  if (!domain) {
    printHelp();
    return;
  }

  if (domain === 'test' && action === 'workspace') {
    const code = await runWorkspaceTests();
    process.exit(code);
  }
  if (domain === 'test' && action === 'integration-core') {
    await runCoreIntegrationTestsCommand(rest);
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
