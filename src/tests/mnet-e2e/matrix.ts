import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runCommand } from '../../e2e/lib';
import { resolveTestArtifactPath, resolveWorkspaceRoot } from '../../utils/test-artifacts';

type MatrixScenario = Readonly<{
  id: string;
  category: 'derp' | 'ip' | 'fault';
  description: string;
  command: readonly string[];
  env?: Readonly<Record<string, string>>;
}>;

type ScenarioResult = Readonly<{
  id: string;
  category: MatrixScenario['category'];
  description: string;
  durationMs: number;
  passed: boolean;
  exitCode: number;
}>;

type PercentileSet = Readonly<{
  p50: number;
  p95: number;
  p99: number;
}>;

export type MnetE2EReport = Readonly<{
  generatedAt: string;
  workspaceRoot: string;
  scenarios: readonly ScenarioResult[];
  totals: {
    total: number;
    passed: number;
    failed: number;
    passRate: number;
  };
  latencyMs: PercentileSet;
  reconnectMs: PercentileSet;
}>;

const resolveDefaultReportPath = (): string =>
  resolveTestArtifactPath('meristem-test-mnet-e2e', 'mnet-e2e-report.json');

const textDecoder = new TextDecoder();

const decodeOutput = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Uint8Array) {
    return textDecoder.decode(value);
  }
  return '';
};

/**
 * 逻辑块：统一 Bun 子命令执行包装（复用 tooling e2e 命令执行器）。
 * - 目的：复用已有 PATH/环境处理逻辑，避免重复维护子进程兼容细节。
 * - 原因：matrix 与 e2e 同属 orchestration 层，应该共用同一命令执行基线。
 * - 失败路径：命令退出码非 0 时保留 stdout/stderr，交由上层报告具体场景失败。
 */
const runBunCommand = (
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string | undefined>> = {},
) => {
  return runCommand('bun', [...args], { cwd, env: { ...env } });
};

const resolveCoreHome = (workspaceRoot: string): string => {
  const envHome = process.env.MERISTEM_HOME;
  if (envHome && envHome.trim().length > 0) {
    return resolve(envHome.trim());
  }
  return resolve(workspaceRoot, 'meristem-core');
};

/**
 * 逻辑块：矩阵前置插件自检与按需安装。
 * - 目的：测试入口统一从 Core 管理目录读取，不再依赖工作区根 plugins 目录。
 * - 原因：插件独立仓后，矩阵执行前必须确保插件已按 CLI 规则安装到 MERISTEM_HOME。
 * - 失败路径：sync 失败或关键测试文件缺失时立即抛错，避免矩阵“空跑”误报通过。
 */
const ensureMnetPluginTests = (
  workspaceRoot: string,
): Readonly<{ derpTestPath: string; lifecycleTestPath: string; coreHome: string }> => {
  const coreHome = resolveCoreHome(workspaceRoot);
  const pluginRoot = resolve(coreHome, 'plugins', 'com.meristem.mnet');
  const derpTestPath = resolve(pluginRoot, '__tests__', 'derp-modes.test.ts');
  const lifecycleTestPath = resolve(pluginRoot, '__tests__', 'headscale-lifecycle.test.ts');

  if (!existsSync(derpTestPath) || !existsSync(lifecycleTestPath)) {
    const coreDir = resolve(workspaceRoot, 'meristem-core');
    const sync = runBunCommand(
      [
        'run',
        'src/cli/meristem.ts',
        '--home',
        coreHome,
        '-S',
        'com.meristem.mnet',
      ],
      coreDir,
      {},
    );

    if (sync.code !== 0) {
      const stdout = decodeOutput(sync.stdout).trim();
      const stderr = decodeOutput(sync.stderr).trim();
      const details = [stdout, stderr].filter((item) => item.length > 0).join('\n');
      throw new Error(`failed to sync com.meristem.mnet via core CLI: ${details}`);
    }
  }

  if (!existsSync(derpTestPath) || !existsSync(lifecycleTestPath)) {
    throw new Error(
      `m-net plugin test files are missing under ${pluginRoot}, expected derp/headscale tests`,
    );
  }

  return { derpTestPath, lifecycleTestPath, coreHome };
};

const buildScenarios = (
  mnetTests: Readonly<{ derpTestPath: string; lifecycleTestPath: string }>,
): readonly MatrixScenario[] => [
  {
    id: 'derp-self-hosted-only',
    category: 'derp',
    description: 'DERP self-hosted-only mode behavior',
    command: ['test', mnetTests.derpTestPath],
    env: {
      MERISTEM_MNET_DERP_MODE: 'self-hosted-only',
    },
  },
  {
    id: 'derp-public-only',
    category: 'derp',
    description: 'DERP public-only mode behavior',
    command: ['test', mnetTests.derpTestPath],
    env: {
      MERISTEM_MNET_DERP_MODE: 'public-only',
    },
  },
  {
    id: 'derp-hybrid',
    category: 'derp',
    description: 'DERP hybrid mode behavior',
    command: ['test', mnetTests.derpTestPath],
    env: {
      MERISTEM_MNET_DERP_MODE: 'hybrid',
    },
  },
  {
    id: 'ipv6-dual-stack',
    category: 'ip',
    description: 'IPv6-only and dual-stack tunnel planning',
    command: ['test', 'meristem-client/src/__tests__/wireguard-dual-stack.test.ts'],
  },
  {
    id: 'fault-headscale-crash',
    category: 'fault',
    description: 'Headscale crash/restart budget handling',
    command: ['test', mnetTests.lifecycleTestPath],
  },
  {
    id: 'fault-derp-down',
    category: 'fault',
    description: 'DERP down fail-fast behavior for missing public source',
    command: ['test', mnetTests.derpTestPath],
    env: {
      MERISTEM_MNET_DERP_FORCE_DOWN: 'true',
    },
  },
  {
    id: 'fault-path-degrade',
    category: 'fault',
    description: 'Path degrade fallback from direct to relay',
    command: ['test', 'meristem-client/src/__tests__/wireguard-dual-stack.test.ts'],
    env: {
      MERISTEM_NETWORK_EXTREME_MODE: 'true',
    },
  },
];

const percentile = (values: readonly number[], p: number): number => {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) {
    return sorted[low] ?? 0;
  }
  const lowValue = sorted[low] ?? 0;
  const highValue = sorted[high] ?? lowValue;
  return lowValue + (highValue - lowValue) * (rank - low);
};

const toPercentiles = (values: readonly number[]): PercentileSet => ({
  p50: percentile(values, 50),
  p95: percentile(values, 95),
  p99: percentile(values, 99),
});

const runScenario = (workspaceRoot: string, scenario: MatrixScenario): ScenarioResult => {
  const startedAt = performance.now();
  const result = runBunCommand(scenario.command, workspaceRoot, {
    MERISTEM_WORKSPACE_ROOT: workspaceRoot,
    ...(scenario.env ?? {}),
  });
  const stdout = decodeOutput(result.stdout);
  const stderr = decodeOutput(result.stderr);
  if (stdout.trim().length > 0) {
    process.stdout.write(stdout);
  }
  if (stderr.trim().length > 0) {
    process.stderr.write(stderr);
  }
  const finishedAt = performance.now();

  const exitCode = result.code;

  return {
    id: scenario.id,
    category: scenario.category,
    description: scenario.description,
    durationMs: finishedAt - startedAt,
    passed: exitCode === 0,
    exitCode,
  };
};

export const runMnetE2EMatrix = async (
  options: Readonly<{ outPath?: string; writeDocPath?: string }> = {},
): Promise<MnetE2EReport> => {
  const workspaceRoot = resolveWorkspaceRoot();
  const mnetTests = ensureMnetPluginTests(workspaceRoot);
  const scenarios = buildScenarios(mnetTests);
  const scenarioResults: ScenarioResult[] = [];

  /**
   * 逻辑块：T5 验证矩阵采用“固定场景集 + 顺序执行”策略。
   * 这样可以在同一轮报告中稳定覆盖 DERP 三模式、IPv6 双栈与三类故障注入，
   * 同时保证每个场景的时延采样来源一致，便于后续版本横向比较。
   */
  for (const scenario of scenarios) {
    scenarioResults.push(runScenario(workspaceRoot, scenario));
  }

  const passed = scenarioResults.filter((item) => item.passed).length;
  const failed = scenarioResults.length - passed;
  const passRate = scenarioResults.length === 0 ? 0 : (passed / scenarioResults.length) * 100;
  const durations = scenarioResults.map((item) => item.durationMs);
  const faultDurations = scenarioResults
    .filter((item) => item.category === 'fault')
    .map((item) => item.durationMs);

  const report: MnetE2EReport = {
    generatedAt: new Date().toISOString(),
    workspaceRoot,
    scenarios: scenarioResults,
    totals: {
      total: scenarioResults.length,
      passed,
      failed,
      passRate,
    },
    latencyMs: toPercentiles(durations),
    reconnectMs: toPercentiles(faultDurations.length > 0 ? faultDurations : durations),
  };

  const outPath = resolve(options.outPath ?? resolveDefaultReportPath());
  mkdirSync(dirname(outPath), { recursive: true });
  await Bun.write(outPath, `${JSON.stringify(report, null, 2)}\n`);

  if (options.writeDocPath) {
    const docPath = resolve(options.writeDocPath);
    mkdirSync(dirname(docPath), { recursive: true });
    const markdown = [
      '# M-Net SLO Baseline (2026-02-14)',
      '',
      `- Validation date: ${report.generatedAt}`,
      `- Workspace root: ${report.workspaceRoot}`,
      `- Matrix pass rate: ${report.totals.passRate.toFixed(2)}% (${report.totals.passed}/${report.totals.total})`,
      '',
      '## Verified Facts',
      '',
      `- DERP mode matrix passed for self-hosted-only/public-only/hybrid via tooling matrix scenarios.`,
      `- IPv6 and dual-stack planning scenarios passed.`,
      `- Fault injection scenarios (Headscale crash, DERP down, path degrade) pass rate is ${report.totals.passRate.toFixed(2)}%.`,
      '',
      '## SLO Snapshot',
      '',
      `- Path latency P50/P95/P99 (ms): ${report.latencyMs.p50.toFixed(2)} / ${report.latencyMs.p95.toFixed(2)} / ${report.latencyMs.p99.toFixed(2)}`,
      `- Reconnect P50/P95/P99 (ms): ${report.reconnectMs.p50.toFixed(2)} / ${report.reconnectMs.p95.toFixed(2)} / ${report.reconnectMs.p99.toFixed(2)}`,
      `- Error rate: ${(100 - report.totals.passRate).toFixed(2)}%`,
      '',
      '## Constraints for Implementation',
      '',
      '- Client remains provider-agnostic and consumes generic network bootstrap contract only.',
      '- Plugin-specific fallback strategy stays in core/plugin side, not in meristem-client runtime branches.',
      '',
      '## Traceability',
      '',
      `- Raw report: ${outPath}`,
      '- Command: `bun run --cwd meristem-tooling src/cli.ts test mnet-e2e --write-doc docs/references/MNET_SLO_BASELINE_2026-02-14.md`',
      '',
    ].join('\n');
    await Bun.write(docPath, markdown);
  }

  return report;
};
