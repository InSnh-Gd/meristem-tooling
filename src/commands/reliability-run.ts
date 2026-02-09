import { resolve } from 'node:path';

type ReliabilitySample = {
  round: number;
  durationMs: number;
  exitCode: number;
};

type ReliabilityReport = {
  generatedAt: string;
  workspaceRoot: string;
  warmupRounds: number;
  measuredRounds: number;
  command: readonly string[];
  samples: readonly ReliabilitySample[];
  stats: {
    averageMs: number;
    medianMs: number;
    trimmedMeanMs: number;
    minMs: number;
    maxMs: number;
  };
};

const parseIntStrict = (value: string | undefined, fallback: number, min: number): number => {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`invalid integer value: ${value}`);
  }
  return parsed;
};

const calculateStats = (values: readonly number[]): ReliabilityReport['stats'] => {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  const averageMs = sum / sorted.length;
  const medianMs =
    sorted.length % 2 === 1
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const trimmed = sorted.length > 2 ? sorted.slice(1, sorted.length - 1) : sorted;
  const trimmedMeanMs = trimmed.reduce((acc, value) => acc + value, 0) / trimmed.length;
  return {
    averageMs,
    medianMs,
    trimmedMeanMs,
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
  };
};

const runSingle = (cmd: readonly string[], cwd: string): ReliabilitySample => {
  const started = performance.now();
  const result = Bun.spawnSync({
    cmd: [...cmd],
    cwd,
    stdout: 'inherit',
    stderr: 'inherit',
    env: {
      ...process.env,
      MERISTEM_WORKSPACE_ROOT: cwd,
    },
  });
  const ended = performance.now();
  return {
    round: 0,
    durationMs: ended - started,
    exitCode: result.exitCode,
  };
};

export const runReliabilityCommand = async (argv: readonly string[] = []): Promise<void> => {
  const args = [...argv];
  let warmupRounds = 1;
  let measuredRounds = 3;
  let outPath: string | null = null;

  while (args.length > 0) {
    const token = args.shift();
    switch (token) {
      case '--warmup': {
        warmupRounds = parseIntStrict(args.shift(), warmupRounds, 0);
        break;
      }
      case '--rounds': {
        measuredRounds = parseIntStrict(args.shift(), measuredRounds, 1);
        break;
      }
      case '--out': {
        outPath = args.shift() ?? null;
        break;
      }
      case '--help': {
        console.log('Usage: tooling reliability run [--warmup <n>] [--rounds <n>] [--out <path>]');
        return;
      }
      default:
        throw new Error(`unknown option: ${token}`);
    }
  }

  const workspaceRoot = resolve(process.env.MERISTEM_WORKSPACE_ROOT ?? process.cwd());
  const command = ['bun', 'run', 'tooling:e2e:run:workspace'] as const;

  /**
   * 逻辑块：可靠性评测执行采用 warmup 丢弃 + 固定轮次采样。
   * warmup 用于消除首次拉起服务的冷启动噪音，最终仅基于 measured 样本计算 median/trimmed mean。
   */
  for (let round = 1; round <= warmupRounds; round += 1) {
    const warmup = runSingle(command, workspaceRoot);
    if (warmup.exitCode !== 0) {
      throw new Error(`reliability warmup failed at round ${round}`);
    }
  }

  const samples: ReliabilitySample[] = [];
  for (let round = 1; round <= measuredRounds; round += 1) {
    const sample = runSingle(command, workspaceRoot);
    if (sample.exitCode !== 0) {
      throw new Error(`reliability measured run failed at round ${round}`);
    }
    samples.push({
      ...sample,
      round,
    });
  }

  const report: ReliabilityReport = {
    generatedAt: new Date().toISOString(),
    workspaceRoot,
    warmupRounds,
    measuredRounds,
    command,
    samples,
    stats: calculateStats(samples.map((item) => item.durationMs)),
  };

  const payload = JSON.stringify(report, null, 2);
  console.log(payload);
  if (outPath) {
    await Bun.write(outPath, payload);
  }
};

if (import.meta.main) {
  runReliabilityCommand(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[tooling:reliability:run] failed: ${message}`);
    process.exit(1);
  });
}
