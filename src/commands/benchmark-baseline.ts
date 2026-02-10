import { runWasmPocBenchmarks, type WasmPocBenchmarkResult } from '../bench/wasm-poc';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTestArtifactPath } from '../utils/test-artifacts';

type BenchmarkSample = {
  name: string;
  iterations: number;
  durationMs: number;
  opsPerSecond: number;
};

type BenchmarkSampleProfile = {
  name: string;
  iterations: number;
  warmupRounds: number;
  measuredRounds: number;
  measuredOpsPerSecond: readonly number[];
  medianOpsPerSecond: number;
  trimmedMeanOpsPerSecond: number;
  minOpsPerSecond: number;
  maxOpsPerSecond: number;
  coefficientOfVariation: number;
};

export type BaselineReport = {
  generatedAt: string;
  runtime: {
    bunVersion: string;
    platform: string;
    arch: string;
  };
  samples: readonly BenchmarkSample[];
  profile: {
    mode: 'single-sample' | 'multi-round';
    warmupRounds: number;
    measuredRounds: number;
    samples: readonly BenchmarkSampleProfile[];
  };
  wasmPoc: WasmPocBenchmarkResult;
};

type BaselineRunOptions = {
  warmupRounds: number;
  measuredRounds: number;
  jsonIterations: number;
  copyIterations: number;
  textIterations: number;
  ioIterations: number;
};

const DEFAULT_WARMUP_ROUNDS = 2;
const DEFAULT_MEASURED_ROUNDS = 5;
const DEFAULT_JSON_ITERATIONS = 20_000;
const DEFAULT_COPY_ITERATIONS = 50_000;
const DEFAULT_TEXT_ITERATIONS = 50_000;
const DEFAULT_IO_ITERATIONS = 800;

const runBenchmark = (
  name: string,
  iterations: number,
  runner: (index: number) => void,
): BenchmarkSample => {
  const start = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    runner(index);
  }
  const durationMs = performance.now() - start;
  const opsPerSecond = iterations / (durationMs / 1000);
  return {
    name,
    iterations,
    durationMs,
    opsPerSecond,
  };
};

const runFileIoBenchmark = (
  name: string,
  iterations: number,
  baseDir: string,
  payload: Uint8Array,
): BenchmarkSample => {
  mkdirSync(baseDir, { recursive: true });
  const benchDir = mkdtempSync(join(baseDir, 'meristem-io-bench-'));
  try {
    return runBenchmark(name, iterations, (index) => {
      const filePath = join(benchDir, `sample-${index & 31}.bin`);
      writeFileSync(filePath, payload);
      const loaded = readFileSync(filePath);
      if (loaded.byteLength !== payload.byteLength) {
        throw new Error('invalid file io sample');
      }
    });
  } finally {
    rmSync(benchDir, { recursive: true, force: true });
  }
};

const parseIntegerOption = (raw: string, option: string, minimum: number): number => {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`${option} must be an integer >= ${minimum}, got "${raw}"`);
  }
  return parsed;
};

const calculateMedian = (values: readonly number[]): number => {
  if (values.length === 0) {
    throw new Error('cannot compute median of empty values');
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle] ?? 0;
};

const calculateTrimmedMean = (values: readonly number[]): number => {
  if (values.length <= 2) {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const trimmed = sorted.slice(1, -1);
  return trimmed.reduce((sum, value) => sum + value, 0) / trimmed.length;
};

const calculateCoefficientOfVariation = (values: readonly number[]): number => {
  if (values.length <= 1) {
    return 0;
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean === 0) {
    return 0;
  }
  const variance =
    values.reduce((sum, value) => {
      const delta = value - mean;
      return sum + delta * delta;
    }, 0) / values.length;
  return Math.sqrt(variance) / mean;
};

const runSingleRound = (options: BaselineRunOptions): BenchmarkSample[] => {
  const payload = {
    node_id: 'bench-node',
    ts: Date.now(),
    metrics: {
      cpu: 0.42,
      mem: 0.65,
      disk: 0.08,
    },
    tags: ['bench', 'runtime'],
  };
  const byteSource = new Uint8Array(4096);
  const ioPayload = new TextEncoder().encode(JSON.stringify(payload).repeat(128));

  const samples: BenchmarkSample[] = [
    runBenchmark('json-stringify-parse', options.jsonIterations, () => {
      const encoded = JSON.stringify(payload);
      const decoded = JSON.parse(encoded) as Record<string, unknown>;
      if (!decoded.node_id) {
        throw new Error('invalid decode');
      }
    }),
    runBenchmark('uint8array-copy', options.copyIterations, () => {
      const copied = byteSource.slice();
      if (copied.byteLength !== byteSource.byteLength) {
        throw new Error('invalid copy');
      }
    }),
    runBenchmark('text-encode-decode', options.textIterations, () => {
      const encoded = new TextEncoder().encode('meristem-benchmark');
      const decoded = new TextDecoder().decode(encoded);
      if (decoded.length === 0) {
        throw new Error('invalid text decode');
      }
    }),
  ];

  /**
   * 逻辑块：新增“磁盘 vs 内存文件系统”对照测量，用于判断瓶颈是否主要来自磁盘 I/O。
   * 这里固定 payload 与迭代次数，先测工作区磁盘，再在可用时测 /dev/shm（内存文件系统）。
   * 若宿主机不存在 /dev/shm 或权限不足，降级为只保留磁盘样本，避免基准流程因环境差异中断。
   */
  const workspaceTmpDir = resolveTestArtifactPath('meristem-test-tmp');
  samples.push(runFileIoBenchmark('file-io-workspace-disk', options.ioIterations, workspaceTmpDir, ioPayload));

  if (existsSync('/dev/shm')) {
    try {
      samples.push(runFileIoBenchmark('file-io-dev-shm', options.ioIterations, '/dev/shm', ioPayload));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[tooling:bench:baseline] skip /dev/shm sample: ${message}`);
      const osTmpDir = tmpdir();
      if (osTmpDir !== workspaceTmpDir) {
        samples.push(runFileIoBenchmark('file-io-os-tmp', options.ioIterations, osTmpDir, ioPayload));
      }
    }
  } else {
    const osTmpDir = tmpdir();
    if (osTmpDir !== workspaceTmpDir) {
      samples.push(runFileIoBenchmark('file-io-os-tmp', options.ioIterations, osTmpDir, ioPayload));
    }
  }

  return samples;
};

const aggregateSampleProfiles = (
  measuredRounds: readonly BenchmarkSample[][],
  options: BaselineRunOptions,
): { samples: BenchmarkSample[]; profiles: BenchmarkSampleProfile[] } => {
  const buckets = new Map<string, { iterations: number; values: number[] }>();
  for (const round of measuredRounds) {
    for (const sample of round) {
      const current = buckets.get(sample.name);
      if (!current) {
        buckets.set(sample.name, { iterations: sample.iterations, values: [sample.opsPerSecond] });
        continue;
      }
      current.values.push(sample.opsPerSecond);
    }
  }

  const profiles: BenchmarkSampleProfile[] = [...buckets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, bucket]) => {
      const values = bucket.values;
      const medianOpsPerSecond = calculateMedian(values);
      const trimmedMeanOpsPerSecond = calculateTrimmedMean(values);
      return {
        name,
        iterations: bucket.iterations,
        warmupRounds: options.warmupRounds,
        measuredRounds: options.measuredRounds,
        measuredOpsPerSecond: values,
        medianOpsPerSecond,
        trimmedMeanOpsPerSecond,
        minOpsPerSecond: Math.min(...values),
        maxOpsPerSecond: Math.max(...values),
        coefficientOfVariation: calculateCoefficientOfVariation(values),
      };
    });

  const samples: BenchmarkSample[] = profiles.map((profile) => ({
    name: profile.name,
    iterations: profile.iterations,
    durationMs: (profile.iterations / profile.medianOpsPerSecond) * 1000,
    opsPerSecond: profile.medianOpsPerSecond,
  }));

  return { samples, profiles };
};

export const runBaselineReport = (options: Partial<BaselineRunOptions> = {}): BaselineReport => {
  const resolvedOptions: BaselineRunOptions = {
    warmupRounds: options.warmupRounds ?? DEFAULT_WARMUP_ROUNDS,
    measuredRounds: options.measuredRounds ?? DEFAULT_MEASURED_ROUNDS,
    jsonIterations: options.jsonIterations ?? DEFAULT_JSON_ITERATIONS,
    copyIterations: options.copyIterations ?? DEFAULT_COPY_ITERATIONS,
    textIterations: options.textIterations ?? DEFAULT_TEXT_ITERATIONS,
    ioIterations: options.ioIterations ?? DEFAULT_IO_ITERATIONS,
  };

  /**
   * 逻辑块：默认改为“warmup + 多轮 measured”后再聚合输出。
   * 这样可以把 JIT/GC/调频造成的单次离群值隔离掉，基线默认直接给出更稳的中位数结果。
   * 若调用方明确需要单样本（例如 pack 自己已经做了外层轮次），可通过 --single-sample 回退。
   */
  for (let round = 0; round < resolvedOptions.warmupRounds; round += 1) {
    runSingleRound(resolvedOptions);
  }
  const measuredRounds = Array.from({ length: resolvedOptions.measuredRounds }, () =>
    runSingleRound(resolvedOptions),
  );
  const { samples, profiles } = aggregateSampleProfiles(measuredRounds, resolvedOptions);
  const wasmPoc = runWasmPocBenchmarks({
    iterations: 600,
  });

  return {
    generatedAt: new Date().toISOString(),
    runtime: {
      bunVersion: Bun.version,
      platform: process.platform,
      arch: process.arch,
    },
    samples,
    profile: {
      mode:
        resolvedOptions.warmupRounds === 0 && resolvedOptions.measuredRounds === 1
          ? 'single-sample'
          : 'multi-round',
      warmupRounds: resolvedOptions.warmupRounds,
      measuredRounds: resolvedOptions.measuredRounds,
      samples: profiles,
    },
    wasmPoc,
  };
};

export const runBaselineCommand = async (argv: readonly string[] = []): Promise<void> => {
  const args = [...argv];
  let outPath: string | null = null;
  const options: Partial<BaselineRunOptions> = {};

  while (args.length > 0) {
    const token = args.shift();
    if (token === '--out') {
      outPath = args.shift() ?? null;
      continue;
    }
    if (token === '--warmup-rounds') {
      options.warmupRounds = parseIntegerOption(args.shift() ?? '', '--warmup-rounds', 0);
      continue;
    }
    if (token === '--rounds') {
      options.measuredRounds = parseIntegerOption(args.shift() ?? '', '--rounds', 1);
      continue;
    }
    if (token === '--json-iterations') {
      options.jsonIterations = parseIntegerOption(args.shift() ?? '', '--json-iterations', 1);
      continue;
    }
    if (token === '--copy-iterations') {
      options.copyIterations = parseIntegerOption(args.shift() ?? '', '--copy-iterations', 1);
      continue;
    }
    if (token === '--text-iterations') {
      options.textIterations = parseIntegerOption(args.shift() ?? '', '--text-iterations', 1);
      continue;
    }
    if (token === '--io-iterations') {
      options.ioIterations = parseIntegerOption(args.shift() ?? '', '--io-iterations', 1);
      continue;
    }
    if (token === '--single-sample') {
      options.warmupRounds = 0;
      options.measuredRounds = 1;
      continue;
    }
    if (token === '--help') {
      console.log(
        'Usage: tooling bench baseline [--out <path>] [--warmup-rounds <n>] [--rounds <n>] [--single-sample] [--json-iterations <n>] [--copy-iterations <n>] [--text-iterations <n>] [--io-iterations <n>]',
      );
      return;
    }
    throw new Error(`unknown option: ${token}`);
  }

  const report = runBaselineReport(options);
  const payload = JSON.stringify(report, null, 2);
  console.log(payload);
  if (outPath) {
    await Bun.write(outPath, payload);
  }
};

if (import.meta.main) {
  runBaselineCommand(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[tooling:bench:baseline] failed: ${message}`);
    process.exit(1);
  });
}
