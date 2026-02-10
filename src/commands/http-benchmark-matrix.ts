import {
  runHttpBenchmarkMatrix,
  type HttpBenchmarkConfig,
  type HttpBenchmarkTarget,
} from '../bench/http-benchmark';
import { createCoreScenarioAdapter, type JoinBenchmarkMode } from '../bench/core-scenario-adapter';

type MatrixReport = {
  generatedAt: string;
  runtime: {
    bunVersion: string;
    platform: string;
    arch: string;
  };
  targetSource: 'adapter-default' | 'file';
  targetsPath: string | null;
  coreBaseUrl: string;
  joinMode: JoinBenchmarkMode;
  config: HttpBenchmarkConfig;
  results: Awaited<ReturnType<typeof runHttpBenchmarkMatrix>>['results'];
  ranking: Awaited<ReturnType<typeof runHttpBenchmarkMatrix>>['ranking'];
};

const parseNumber = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
};

const parseArgs = (argv: readonly string[]): {
  targetsPath: string | null;
  coreBaseUrl: string;
  joinMode: JoinBenchmarkMode;
  outPath: string | null;
  config: HttpBenchmarkConfig;
} => {
  const args = [...argv];

  let targetsPath: string | null = null;
  let coreBaseUrl = 'http://127.0.0.1:3000';
  let joinMode: JoinBenchmarkMode = 'same-hwid';
  let outPath: string | null = null;
  let requests = 400;
  let concurrency = 40;
  let warmupRequests = 40;
  let timeoutMs = 3000;

  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      break;
    }
    switch (token) {
      case '--targets': {
        const parsedPath = args.shift() ?? '';
        targetsPath = parsedPath.length > 0 ? parsedPath : null;
        break;
      }
      case '--core-base-url': {
        const parsedBaseUrl = args.shift() ?? '';
        if (parsedBaseUrl.length > 0) {
          coreBaseUrl = parsedBaseUrl;
        }
        break;
      }
      case '--out': {
        outPath = args.shift() ?? null;
        break;
      }
      case '--join-mode': {
        const parsedJoinMode = args.shift();
        if (parsedJoinMode === 'same-hwid' || parsedJoinMode === 'unique-hwid') {
          joinMode = parsedJoinMode;
          break;
        }
        throw new Error(`invalid --join-mode value: ${parsedJoinMode ?? ''}`);
      }
      case '--requests': {
        requests = parseNumber(args.shift(), requests);
        break;
      }
      case '--concurrency': {
        concurrency = parseNumber(args.shift(), concurrency);
        break;
      }
      case '--warmup': {
        warmupRequests = parseNumber(args.shift(), warmupRequests);
        break;
      }
      case '--timeout-ms': {
        timeoutMs = parseNumber(args.shift(), timeoutMs);
        break;
      }
      case '--help': {
        console.log('Usage: tooling bench http-matrix [--targets <path>] [--out <path>] [--join-mode same-hwid|unique-hwid] [--requests <n>] [--concurrency <n>] [--warmup <n>] [--timeout-ms <n>]');
        process.exit(0);
      }
      default:
        throw new Error(`unknown option: ${token}`);
    }
  }

  return {
    targetsPath,
    coreBaseUrl,
    joinMode,
    outPath,
    config: {
      requests: Math.max(1, Math.floor(requests)),
      concurrency: Math.max(1, Math.floor(concurrency)),
      warmupRequests: Math.max(0, Math.floor(warmupRequests)),
      timeoutMs: Math.max(100, Math.floor(timeoutMs)),
    },
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isTarget = (value: unknown): value is HttpBenchmarkTarget => {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.name !== 'string' || value.name.length === 0) {
    return false;
  }
  if (typeof value.url !== 'string' || value.url.length === 0) {
    return false;
  }
  if (value.method !== 'GET' && value.method !== 'POST') {
    return false;
  }
  return true;
};

const parseTargets = (raw: unknown): HttpBenchmarkTarget[] => {
  if (!isRecord(raw)) {
    throw new Error('targets file must be an object');
  }
  const targets = raw.targets;
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('targets file must include non-empty targets[]');
  }
  if (!targets.every(isTarget)) {
    throw new Error('targets[] contains invalid target entries');
  }
  return targets;
};

export const runHttpBenchmarkMatrixCommand = async (argv: readonly string[] = []): Promise<void> => {
  const parsed = parseArgs(argv);
  const scenarioAdapter = createCoreScenarioAdapter({ joinMode: parsed.joinMode });
  let targets: readonly HttpBenchmarkTarget[];
  let targetSource: MatrixReport['targetSource'];

  if (parsed.targetsPath) {
    const targetsFile = Bun.file(parsed.targetsPath);
    const decoded = (await targetsFile.json()) as unknown;
    targets = parseTargets(decoded);
    targetSource = 'file';
  } else {
    /**
     * 逻辑块：无外部 targets 文件时，默认加载核心健康检查 + join 写路径。
     * 这样可以确保在任何环境下都能得到至少一组可比较样本，避免因参数缺失导致压测命令空跑。
     */
    targets = scenarioAdapter.buildTargets(parsed.coreBaseUrl);
    targetSource = 'adapter-default';
  }

  const matrix = await runHttpBenchmarkMatrix(
    targets,
    parsed.config,
    fetch,
    scenarioAdapter.classifySuccess,
  );
  const report: MatrixReport = {
    generatedAt: new Date().toISOString(),
    runtime: {
      bunVersion: Bun.version,
      platform: process.platform,
      arch: process.arch,
    },
    targetSource,
    targetsPath: parsed.targetsPath,
    coreBaseUrl: parsed.coreBaseUrl,
    joinMode: scenarioAdapter.joinMode,
    config: parsed.config,
    results: matrix.results,
    ranking: matrix.ranking,
  };

  const payload = JSON.stringify(report, null, 2);
  console.log(payload);

  if (parsed.outPath) {
    await Bun.write(parsed.outPath, payload);
  }
};

if (import.meta.main) {
  runHttpBenchmarkMatrixCommand(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[tooling:bench:http-matrix] failed: ${message}`);
    process.exit(1);
  });
}
