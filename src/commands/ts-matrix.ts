import { join, resolve } from 'node:path';

type TypecheckSample = {
  round: number;
  durationMs: number;
  exitCode: number;
};

type TypecheckTrackReport = {
  mode: 'ts5' | 'ts7';
  command: readonly string[];
  warmupRounds: number;
  measuredRounds: number;
  samples: readonly TypecheckSample[];
  stats: {
    averageMs: number;
    medianMs: number;
    trimmedMeanMs: number;
    minMs: number;
    maxMs: number;
  } | null;
};

type TypecheckMatrixReport = {
  generatedAt: string;
  workspaceRoot: string;
  coreDir: string;
  tracks: readonly TypecheckTrackReport[];
  comparison: {
    speedupFactor: number | null;
    ts5MedianMs: number | null;
    ts7MedianMs: number | null;
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

const calculateStats = (values: readonly number[]): TypecheckTrackReport['stats'] => {
  if (values.length === 0) {
    return null;
  }
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

const runSingle = (cmd: readonly string[], cwd: string): TypecheckSample => {
  const started = performance.now();
  const result = Bun.spawnSync({
    cmd: [...cmd],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      FORCE_COLOR: '0',
    },
  });
  const ended = performance.now();
  return {
    round: 0,
    durationMs: ended - started,
    exitCode: result.exitCode,
  };
};

const runTrack = (input: {
  mode: 'ts5' | 'ts7';
  cmd: readonly string[];
  cwd: string;
  warmupRounds: number;
  measuredRounds: number;
}): TypecheckTrackReport => {
  for (let i = 0; i < input.warmupRounds; i += 1) {
    const warmup = runSingle(input.cmd, input.cwd);
    if (warmup.exitCode !== 0) {
      throw new Error(`${input.mode} warmup failed at round ${i + 1}`);
    }
  }

  const samples: TypecheckSample[] = [];
  for (let i = 0; i < input.measuredRounds; i += 1) {
    const sample = runSingle(input.cmd, input.cwd);
    if (sample.exitCode !== 0) {
      throw new Error(`${input.mode} measured run failed at round ${i + 1}`);
    }
    samples.push({
      ...sample,
      round: i + 1,
    });
  }

  return {
    mode: input.mode,
    command: input.cmd,
    warmupRounds: input.warmupRounds,
    measuredRounds: input.measuredRounds,
    samples,
    stats: calculateStats(samples.map((item) => item.durationMs)),
  };
};

export const runTypecheckMatrixCommand = async (argv: readonly string[] = []): Promise<void> => {
  const args = [...argv];
  let warmupRounds = 2;
  let measuredRounds = 5;
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
        console.log('Usage: tooling bench ts-matrix [--warmup <n>] [--rounds <n>] [--out <path>]');
        return;
      }
      default:
        throw new Error(`unknown option: ${token}`);
    }
  }

  const workspaceRoot = resolve(process.env.MERISTEM_WORKSPACE_ROOT ?? process.cwd());
  const coreDir = join(workspaceRoot, 'meristem-core');

  /**
   * 逻辑块：TS 双轨测量固定采用“warmup + 固定轮次 + median/trimmed mean”。
   * 这样可以最大化消除冷启动与瞬时噪音，避免单轮结果误导 TS5/TS7 的实际收益判断。
   */
  const ts5 = runTrack({
    mode: 'ts5',
    cmd: ['bun', 'run', 'typecheck:run:stable'],
    cwd: coreDir,
    warmupRounds,
    measuredRounds,
  });

  const ts7 = runTrack({
    mode: 'ts7',
    cmd: ['bun', 'run', 'typecheck:run:next'],
    cwd: coreDir,
    warmupRounds,
    measuredRounds,
  });

  const ts5Median = ts5.stats?.medianMs ?? null;
  const ts7Median = ts7.stats?.medianMs ?? null;

  const report: TypecheckMatrixReport = {
    generatedAt: new Date().toISOString(),
    workspaceRoot,
    coreDir,
    tracks: [ts5, ts7],
    comparison: {
      speedupFactor: ts5Median && ts7Median ? ts5Median / ts7Median : null,
      ts5MedianMs: ts5Median,
      ts7MedianMs: ts7Median,
    },
  };

  const payload = JSON.stringify(report, null, 2);
  console.log(payload);
  if (outPath) {
    await Bun.write(outPath, payload);
  }
};

if (import.meta.main) {
  runTypecheckMatrixCommand(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[tooling:bench:ts-matrix] failed: ${message}`);
    process.exit(1);
  });
}
