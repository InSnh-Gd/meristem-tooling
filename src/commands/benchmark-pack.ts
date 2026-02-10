import { basename, dirname, join, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import {
  createCoreScenarioAdapter,
  type HttpMatrixTargetStats,
} from '../bench/core-scenario-adapter';
import {
  createTimestampedTestArtifactDir,
  resolveWorkspaceRoot,
} from '../utils/test-artifacts';

type BenchmarkSample = {
  name: string;
  iterations: number;
  durationMs: number;
  opsPerSecond: number;
};

type BaselineReport = {
  generatedAt: string;
  runtime: {
    bunVersion: string;
    platform: string;
    arch: string;
  };
  samples: readonly BenchmarkSample[];
};

type BaselineStats = {
  rounds: number;
  averageOpsPerSecond: number;
  medianOpsPerSecond: number;
  trimmedMeanOpsPerSecond: number;
  minOpsPerSecond: number;
  maxOpsPerSecond: number;
  coefficientOfVariation: number;
};

type BaselineComparison = {
  referenceType: 'profile';
  referenceMedianOpsPerSecond: number;
  referenceTrimmedMeanOpsPerSecond: number;
  medianDeltaPct: number;
  trimmedMeanDeltaPct: number;
};

type BaselineProfileMetric = {
  name: string;
  rounds: number;
  medianOpsPerSecond: number;
  trimmedMeanOpsPerSecond: number;
  minOpsPerSecond: number;
  maxOpsPerSecond: number;
  coefficientOfVariation: number;
};

type BaselineProfile = {
  generatedAt: string;
  runtime: {
    bunVersion: string;
    bunRevision: string | null;
    platform: string;
    arch: string;
  };
  options: {
    warmupRounds: number;
    rounds: number;
    intervalMs: number;
  };
  metrics: readonly BaselineProfileMetric[];
};

type ComparisonSource = {
  mode: 'profile';
  sourcePath: string;
  values: Map<string, BaselineProfileMetric>;
};

type BaselineSummaryItem = {
  name: string;
  stats: BaselineStats;
  comparison: BaselineComparison | null;
};

type HttpMatrixReport = {
  targets: readonly HttpMatrixTargetStats[];
};

type PackOptions = {
  warmupRounds: number;
  rounds: number;
  intervalMs: number;
  outDir: string | null;
  comparePath: string | null;
  profileOut: string | null;
  withHttp: boolean;
  withReliability: boolean;
  archive: boolean;
  httpTargets: string | null;
  httpRequests: number;
  httpConcurrency: number;
  httpWarmup: number;
  httpTimeoutMs: number;
  gateMaxCv: number;
  gateMaxMedianRegressionPct: number;
  gateRequireComparison: boolean;
};

export type BenchmarkGateInputMetric = {
  name: string;
  coefficientOfVariation: number;
  medianDeltaPct: number | null;
};

export type BenchmarkGatePolicy = {
  maxCv: number;
  maxMedianRegressionPct: number;
  requireComparison: boolean;
};

export type BenchmarkGateViolation = {
  metric: string;
  rule: 'cv' | 'median-regression' | 'missing-comparison';
  actual: number | null;
  threshold: number | null;
  message: string;
};

export type BenchmarkGateResult = {
  passed: boolean;
  compared: boolean;
  policy: BenchmarkGatePolicy;
  violations: readonly BenchmarkGateViolation[];
};

type PackReport = {
  generatedAt: string;
  runtime: {
    bunVersion: string;
    bunRevision: string | null;
    platform: string;
    arch: string;
  };
  options: {
    warmupRounds: number;
    rounds: number;
    intervalMs: number;
    withHttp: boolean;
    withReliability: boolean;
    archive: boolean;
    comparePath: string | null;
    profileOut: string | null;
    comparisonMode: 'none' | 'profile';
    comparisonResolvedPath: string | null;
    gateMaxCv: number;
    gateMaxMedianRegressionPct: number;
    gateRequireComparison: boolean;
  };
  paths: {
    outDir: string;
    warmupDir: string;
    measuredDir: string;
    baselineProfileJson: string;
    summaryJson: string;
    summaryMd: string;
    httpMatrixJson: string | null;
    reliabilityLog: string | null;
    archive: string | null;
  };
  baseline: readonly BaselineSummaryItem[];
  http: {
    enabled: boolean;
    command: readonly string[];
    outputPath: string | null;
  };
  reliability: {
    enabled: boolean;
    command: readonly string[];
    logPath: string | null;
  };
  gate: BenchmarkGateResult;
};

const DEFAULT_PROFILE_COMPARE_PATH = 'benchmarks/baseline-profile.json';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isString = (value: unknown): value is string => typeof value === 'string';

const isBenchmarkSample = (value: unknown): value is BenchmarkSample => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.name === 'string' &&
    isNumber(value.iterations) &&
    isNumber(value.durationMs) &&
    isNumber(value.opsPerSecond)
  );
};

const isBaselineReport = (value: unknown): value is BaselineReport => {
  if (!isRecord(value)) {
    return false;
  }
  if (!Array.isArray(value.samples) || !value.samples.every(isBenchmarkSample)) {
    return false;
  }
  if (!isRecord(value.runtime)) {
    return false;
  }
  return (
    typeof value.generatedAt === 'string' &&
    typeof value.runtime.bunVersion === 'string' &&
    typeof value.runtime.platform === 'string' &&
    typeof value.runtime.arch === 'string'
  );
};

const isBaselineProfileMetric = (value: unknown): value is BaselineProfileMetric => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isString(value.name) &&
    isNumber(value.rounds) &&
    isNumber(value.medianOpsPerSecond) &&
    isNumber(value.trimmedMeanOpsPerSecond) &&
    isNumber(value.minOpsPerSecond) &&
    isNumber(value.maxOpsPerSecond) &&
    isNumber(value.coefficientOfVariation)
  );
};

const isBaselineProfile = (value: unknown): value is BaselineProfile => {
  if (!isRecord(value)) {
    return false;
  }
  if (!isRecord(value.runtime) || !isRecord(value.options)) {
    return false;
  }
  if (!Array.isArray(value.metrics) || !value.metrics.every(isBaselineProfileMetric)) {
    return false;
  }
  return (
    isString(value.generatedAt) &&
    isString(value.runtime.bunVersion) &&
    (value.runtime.bunRevision === null || isString(value.runtime.bunRevision)) &&
    isString(value.runtime.platform) &&
    isString(value.runtime.arch) &&
    isNumber(value.options.warmupRounds) &&
    isNumber(value.options.rounds) &&
    isNumber(value.options.intervalMs)
  );
};

const parseIntStrict = (raw: string, option: string, minimum: number): number => {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`${option} must be an integer >= ${minimum}, got "${raw}"`);
  }
  return parsed;
};

const parseFloatStrict = (raw: string, option: string, minimum: number): number => {
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`${option} must be a number >= ${minimum}, got "${raw}"`);
  }
  return parsed;
};

const parseBooleanFlag = (raw: string, option: string): boolean => {
  if (raw === 'true' || raw === '1') {
    return true;
  }
  if (raw === 'false' || raw === '0') {
    return false;
  }
  throw new Error(`${option} expects true/false/1/0, got "${raw}"`);
};

const defaultOptions = (): PackOptions => ({
  warmupRounds: 5,
  rounds: 12,
  intervalMs: 1000,
  outDir: null,
  comparePath: null,
  profileOut: null,
  withHttp: false,
  withReliability: false,
  archive: true,
  httpTargets: null,
  httpRequests: 1200,
  httpConcurrency: 80,
  httpWarmup: 80,
  httpTimeoutMs: 3000,
  gateMaxCv: 0.35,
  gateMaxMedianRegressionPct: 20,
  gateRequireComparison: false,
});

const printHelp = (): void => {
  console.log(`
Usage:
  bun run meristem-tooling/src/cli.ts bench pack [options]

Options:
  --warmup-rounds <n>          Warmup rounds (discarded, default: 5)
  --rounds <n>                 Measured rounds (default: 12)
  --interval-ms <n>            Interval between rounds in ms (default: 1000)
  --out-dir <path>             Output directory (default: <workspace>/meristem-test-output/meristem-test-pack-<timestamp>)
  --compare-path <path>        Comparison profile path (baseline-profile.json)
  --profile-out <path>         Output path for generated baseline profile json
  --with-http                  Enable HTTP matrix benchmark run
  --with-reliability           Enable root-level e2e reliability run (bun run tooling:e2e:run:workspace)
  --archive <true|false>       Create tar.gz archive (default: true)
  --http-targets <path>        HTTP benchmark targets path (default: adapter core health/join targets)
  --http-requests <n>          HTTP requests per target (default: 1200)
  --http-concurrency <n>       HTTP concurrency per target (default: 80)
  --http-warmup <n>            HTTP warmup requests (default: 80)
  --http-timeout-ms <n>        HTTP request timeout in ms (default: 3000)
  --gate-max-cv <n>            Gate threshold: max allowed coefficient of variation (default: 0.35)
  --gate-max-median-regression-pct <n> Gate threshold: max allowed median regression percent (default: 20)
  --gate-require-comparison <true|false> Require comparison profile for gate evaluation (default: false)
  --help                       Show this help
`);
};

const parseArgs = (argv: readonly string[]): PackOptions => {
  const options = defaultOptions();
  const args = [...argv];

  // 这段参数解析逻辑用于把“一键命令”展开成可重复的评测配置，避免手工多次执行时出现口径漂移。
  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      break;
    }

    switch (token) {
      case '--warmup-rounds': {
        options.warmupRounds = parseIntStrict(args.shift() ?? '', '--warmup-rounds', 0);
        break;
      }
      case '--rounds': {
        options.rounds = parseIntStrict(args.shift() ?? '', '--rounds', 1);
        break;
      }
      case '--interval-ms': {
        options.intervalMs = parseIntStrict(args.shift() ?? '', '--interval-ms', 0);
        break;
      }
      case '--out-dir': {
        const value = args.shift() ?? '';
        if (value.length === 0) {
          throw new Error('--out-dir requires a non-empty path');
        }
        options.outDir = value;
        break;
      }
      case '--compare-path': {
        const value = args.shift() ?? '';
        if (value.length === 0) {
          throw new Error('--compare-path requires a non-empty path');
        }
        options.comparePath = value;
        break;
      }
      case '--profile-out': {
        const value = args.shift() ?? '';
        if (value.length === 0) {
          throw new Error('--profile-out requires a non-empty path');
        }
        options.profileOut = value;
        break;
      }
      case '--with-http': {
        options.withHttp = true;
        break;
      }
      case '--with-reliability': {
        options.withReliability = true;
        break;
      }
      case '--archive': {
        options.archive = parseBooleanFlag(args.shift() ?? '', '--archive');
        break;
      }
      case '--http-targets': {
        const value = args.shift() ?? '';
        if (value.length === 0) {
          throw new Error('--http-targets requires a non-empty path');
        }
        options.httpTargets = value;
        break;
      }
      case '--http-requests': {
        options.httpRequests = parseIntStrict(args.shift() ?? '', '--http-requests', 1);
        break;
      }
      case '--http-concurrency': {
        options.httpConcurrency = parseIntStrict(args.shift() ?? '', '--http-concurrency', 1);
        break;
      }
      case '--http-warmup': {
        options.httpWarmup = parseIntStrict(args.shift() ?? '', '--http-warmup', 0);
        break;
      }
      case '--http-timeout-ms': {
        options.httpTimeoutMs = parseIntStrict(args.shift() ?? '', '--http-timeout-ms', 100);
        break;
      }
      case '--gate-max-cv': {
        options.gateMaxCv = parseFloatStrict(args.shift() ?? '', '--gate-max-cv', 0);
        break;
      }
      case '--gate-max-median-regression-pct': {
        options.gateMaxMedianRegressionPct = parseFloatStrict(
          args.shift() ?? '',
          '--gate-max-median-regression-pct',
          0,
        );
        break;
      }
      case '--gate-require-comparison': {
        options.gateRequireComparison = parseBooleanFlag(
          args.shift() ?? '',
          '--gate-require-comparison',
        );
        break;
      }
      case '--help': {
        printHelp();
        process.exit(0);
      }
      default: {
        throw new Error(`unknown option: ${token}`);
      }
    }
  }

  return options;
};

const decodeUtf8 = (payload: Uint8Array | null): string =>
  payload === null ? '' : new TextDecoder().decode(payload);

const runCommand = (command: readonly string[], cwd: string): string => {
  const result = Bun.spawnSync({
    cmd: [...command],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  });
  const stdout = decodeUtf8(result.stdout);
  const stderr = decodeUtf8(result.stderr);
  if (result.exitCode !== 0) {
    const message = stderr.length > 0 ? stderr : stdout;
    throw new Error(`command failed (${command.join(' ')}):\n${message}`);
  }
  return stdout;
};

const calculateStats = (values: readonly number[]): BaselineStats => {
  if (values.length === 0) {
    throw new Error('cannot summarize empty values');
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rounds = sorted.length;
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  const averageOpsPerSecond = sum / rounds;
  const medianOpsPerSecond =
    rounds % 2 === 1
      ? sorted[(rounds - 1) / 2]
      : (sorted[rounds / 2 - 1] + sorted[rounds / 2]) / 2;
  const trimmedValues = rounds > 2 ? sorted.slice(1, rounds - 1) : sorted;
  const trimmedMeanOpsPerSecond =
    trimmedValues.reduce((acc, value) => acc + value, 0) / trimmedValues.length;
  const minOpsPerSecond = sorted[0];
  const maxOpsPerSecond = sorted[rounds - 1];
  const variance =
    sorted.reduce((acc, value) => acc + (value - averageOpsPerSecond) ** 2, 0) / rounds;
  const coefficientOfVariation =
    averageOpsPerSecond === 0 ? 0 : Math.sqrt(variance) / averageOpsPerSecond;

  return {
    rounds,
    averageOpsPerSecond,
    medianOpsPerSecond,
    trimmedMeanOpsPerSecond,
    minOpsPerSecond,
    maxOpsPerSecond,
    coefficientOfVariation,
  };
};

const formatNumber = (value: number): string => value.toFixed(2);

const formatPercent = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;

const normalizeOutDir = (workspaceRoot: string, outDir: string | null): string => {
  if (outDir && outDir.length > 0) {
    return resolve(workspaceRoot, outDir);
  }
  return createTimestampedTestArtifactDir('meristem-test-pack');
};

const parseBaselineReport = (raw: string, source: string): BaselineReport => {
  const decoded = JSON.parse(raw) as unknown;
  if (!isBaselineReport(decoded)) {
    throw new Error(`invalid baseline report: ${source}`);
  }
  return decoded;
};

const parseHttpMatrixReport = (raw: string, source: string): HttpMatrixReport => {
  const decoded = JSON.parse(raw) as unknown;
  if (!isRecord(decoded)) {
    throw new Error(`invalid http matrix report: ${source}`);
  }
  const results = decoded.results;
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error(`http matrix results is empty: ${source}`);
  }

  const targets: HttpMatrixTargetStats[] = [];

  for (const result of results) {
    if (!isRecord(result) || !isRecord(result.target) || !isRecord(result.metrics)) {
      throw new Error(`invalid http matrix result entry: ${source}`);
    }

    const name = result.target.name;
    const requests = result.metrics.requests;
    const success = result.metrics.success;
    const failures = result.metrics.failures;
    const errorRate = result.metrics.errorRate;

    if (
      !isString(name) ||
      !isNumber(requests) ||
      !isNumber(success) ||
      !isNumber(failures) ||
      !isNumber(errorRate)
    ) {
      throw new Error(`invalid http matrix metrics shape: ${source}`);
    }

    targets.push({
      name,
      requests,
      success,
      failures,
      errorRate,
    });
  }

  return { targets };
};

const toProfileMetricMap = (profile: BaselineProfile): Map<string, BaselineProfileMetric> =>
  new Map(profile.metrics.map((metric) => [metric.name, metric]));

export const decodeComparisonSource = (decoded: unknown, comparePath: string): ComparisonSource => {
  if (isBaselineProfile(decoded)) {
    return {
      mode: 'profile',
      sourcePath: comparePath,
      values: toProfileMetricMap(decoded),
    };
  }
  if (isBaselineReport(decoded)) {
    throw new Error(
      `legacy single-sample baseline is not supported: ${comparePath}. Use baseline profile generated by tooling bench pack.`,
    );
  }
  throw new Error(`unsupported compare file format: ${comparePath}`);
};

const resolveComparisonPath = async (options: PackOptions, coreDir: string): Promise<string | null> => {
  if (options.comparePath !== null) {
    return resolve(coreDir, options.comparePath);
  }
  // 逻辑块：默认仅接受 profile 基线，明确淘汰 single-sample 回退路径，避免离群样本污染门禁判断。
  const defaultProfile = resolve(coreDir, DEFAULT_PROFILE_COMPARE_PATH);
  if (await Bun.file(defaultProfile).exists()) {
    return defaultProfile;
  }
  return null;
};

const maybeLoadComparisonSource = async (
  options: PackOptions,
  coreDir: string,
): Promise<ComparisonSource | null> => {
  // 逻辑块：对比源解析只接受 profile，任何 single-sample 基线都直接失败，强制统一到多轮统计口径。
  const comparePath = await resolveComparisonPath(options, coreDir);
  if (comparePath === null) {
    return null;
  }
  const compareFile = Bun.file(comparePath);
  if (!(await compareFile.exists())) {
    throw new Error(`compare baseline not found: ${comparePath}`);
  }
  const compareRaw = await compareFile.text();
  const decoded = JSON.parse(compareRaw) as unknown;
  return decodeComparisonSource(decoded, comparePath);
};

const buildComparison = (
  stats: BaselineStats,
  metricName: string,
  source: ComparisonSource | null,
): BaselineComparison | null => {
  if (source === null) {
    return null;
  }
  const profileMetric = source.values.get(metricName);
  if (!profileMetric) {
    return null;
  }
  return {
    referenceType: 'profile',
    referenceMedianOpsPerSecond: profileMetric.medianOpsPerSecond,
    referenceTrimmedMeanOpsPerSecond: profileMetric.trimmedMeanOpsPerSecond,
    medianDeltaPct:
      ((stats.medianOpsPerSecond - profileMetric.medianOpsPerSecond) /
        profileMetric.medianOpsPerSecond) *
      100,
    trimmedMeanDeltaPct:
      ((stats.trimmedMeanOpsPerSecond - profileMetric.trimmedMeanOpsPerSecond) /
        profileMetric.trimmedMeanOpsPerSecond) *
      100,
  };
};

export const evaluateBenchmarkGate = (
  metrics: readonly BenchmarkGateInputMetric[],
  compared: boolean,
  policy: BenchmarkGatePolicy,
): BenchmarkGateResult => {
  const violations: BenchmarkGateViolation[] = [];

  // 逻辑块：门禁策略同时检查“稳定性(CV)”与“性能退化(median delta)”。
  // 若开启 requireComparison 且未提供 profile，对比缺失会直接触发失败，避免无基线时误判为通过。
  if (!compared && policy.requireComparison) {
    violations.push({
      metric: '*',
      rule: 'missing-comparison',
      actual: null,
      threshold: null,
      message: 'comparison profile is required by gate policy',
    });
  }

  for (const metric of metrics) {
    if (metric.coefficientOfVariation > policy.maxCv) {
      violations.push({
        metric: metric.name,
        rule: 'cv',
        actual: metric.coefficientOfVariation,
        threshold: policy.maxCv,
        message: `coefficient of variation exceeds threshold`,
      });
    }

    if (!compared) {
      continue;
    }

    if (metric.medianDeltaPct === null) {
      violations.push({
        metric: metric.name,
        rule: 'missing-comparison',
        actual: null,
        threshold: null,
        message: 'missing comparison metric in baseline profile',
      });
      continue;
    }

    const regressionLimit = -policy.maxMedianRegressionPct;
    if (metric.medianDeltaPct < regressionLimit) {
      violations.push({
        metric: metric.name,
        rule: 'median-regression',
        actual: metric.medianDeltaPct,
        threshold: regressionLimit,
        message: `median regression exceeds threshold`,
      });
    }
  }

  return {
    passed: violations.length === 0,
    compared,
    policy,
    violations,
  };
};

const buildSummaryMarkdown = (report: PackReport): string => {
  const lines: string[] = [
    '# Benchmark Pack Summary',
    '',
    `- GeneratedAt: ${report.generatedAt}`,
    `- Bun: ${report.runtime.bunVersion}`,
    `- BunRevision: ${report.runtime.bunRevision ?? 'unknown'}`,
    `- Platform: ${report.runtime.platform}/${report.runtime.arch}`,
    `- OutDir: ${report.paths.outDir}`,
    `- WarmupDir: ${report.paths.warmupDir}`,
    `- MeasuredDir: ${report.paths.measuredDir}`,
    `- WarmupRounds: ${report.options.warmupRounds}`,
    `- MeasuredRounds: ${report.options.rounds}`,
    `- ComparisonMode: ${report.options.comparisonMode}`,
    `- ComparisonSource: ${report.options.comparisonResolvedPath ?? 'none'}`,
    `- ProfileOutput: ${report.paths.baselineProfileJson}`,
    `- GateMaxCv: ${report.options.gateMaxCv}`,
    `- GateMaxMedianRegressionPct: ${report.options.gateMaxMedianRegressionPct}`,
    `- GateRequireComparison: ${report.options.gateRequireComparison}`,
    '',
    '## Baseline',
    '',
    '| Name | Rounds | Avg ops/s | Median ops/s | Trimmed ops/s | Min | Max | CV |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];

  for (const item of report.baseline) {
    lines.push(
      `| ${item.name} | ${item.stats.rounds} | ${formatNumber(item.stats.averageOpsPerSecond)} | ${formatNumber(item.stats.medianOpsPerSecond)} | ${formatNumber(item.stats.trimmedMeanOpsPerSecond)} | ${formatNumber(item.stats.minOpsPerSecond)} | ${formatNumber(item.stats.maxOpsPerSecond)} | ${formatNumber(item.stats.coefficientOfVariation)} |`,
    );
  }

  if (report.baseline.some((item) => item.comparison !== null)) {
    lines.push(
      '',
      '## Baseline Delta',
      '',
      '| Name | Ref Type | Ref Median ops/s | Ref Trimmed ops/s | Median Δ | Trimmed Δ |',
      '| --- | --- | ---: | ---: | ---: | ---: |',
    );
    for (const item of report.baseline) {
      if (!item.comparison) {
        continue;
      }
      lines.push(
        `| ${item.name} | ${item.comparison.referenceType} | ${formatNumber(item.comparison.referenceMedianOpsPerSecond)} | ${formatNumber(item.comparison.referenceTrimmedMeanOpsPerSecond)} | ${formatPercent(item.comparison.medianDeltaPct)} | ${formatPercent(item.comparison.trimmedMeanDeltaPct)} |`,
      );
    }
  }

  lines.push(
    '',
    '## Gate',
    '',
    `- Passed: ${report.gate.passed}`,
    `- Compared: ${report.gate.compared}`,
    `- Policy.MaxCv: ${report.gate.policy.maxCv}`,
    `- Policy.MaxMedianRegressionPct: ${report.gate.policy.maxMedianRegressionPct}`,
    `- Policy.RequireComparison: ${report.gate.policy.requireComparison}`,
  );
  if (report.gate.violations.length > 0) {
    lines.push(
      '',
      '| Metric | Rule | Actual | Threshold | Message |',
      '| --- | --- | ---: | ---: | --- |',
    );
    for (const violation of report.gate.violations) {
      const actualText =
        violation.actual === null ? 'N/A' : formatNumber(violation.actual);
      const thresholdText =
        violation.threshold === null ? 'N/A' : formatNumber(violation.threshold);
      lines.push(
        `| ${violation.metric} | ${violation.rule} | ${actualText} | ${thresholdText} | ${violation.message} |`,
      );
    }
  }

  lines.push('', '## Extra Runs', '', `- HTTP Matrix Enabled: ${report.http.enabled}`, `- Reliability Enabled: ${report.reliability.enabled}`);
  if (report.http.outputPath) {
    lines.push(`- HTTP Matrix Output: ${report.http.outputPath}`);
  }
  if (report.reliability.logPath) {
    lines.push(`- Reliability Log: ${report.reliability.logPath}`);
  }
  if (report.paths.archive) {
    lines.push(`- Archive: ${report.paths.archive}`);
  }
  lines.push('');
  return lines.join('\n');
};

export const runBenchmarkPackCommand = async (argv: readonly string[] = []): Promise<void> => {
  const options = parseArgs(argv);
  const scenarioAdapter = createCoreScenarioAdapter();
  const workspaceRoot = resolveWorkspaceRoot();
  const coreDir = join(workspaceRoot, 'meristem-core');
  const repoRoot = workspaceRoot;
  const toolingCliPath = join(workspaceRoot, 'meristem-tooling', 'src', 'cli.ts');
  const outDir = normalizeOutDir(workspaceRoot, options.outDir);
  const warmupDir = join(outDir, 'warmup');
  const measuredDir = join(outDir, 'measured');
  const baselineProfilePath =
    options.profileOut === null ? join(outDir, 'baseline-profile.json') : resolve(coreDir, options.profileOut);
  const summaryJsonPath = join(outDir, 'benchmark-pack-summary.json');
  const summaryMdPath = join(outDir, 'benchmark-pack-summary.md');
  const httpOutPath = join(outDir, 'http-matrix.json');
  const reliabilityLogPath = join(outDir, 'reliability-e2e.log');
  const baselineBuckets = new Map<string, number[]>();

  // 这段目录准备逻辑用于把同轮评测的所有产物收敛到单一目录，便于复现、对比和对外共享。
  await mkdir(outDir, { recursive: true });
  await mkdir(warmupDir, { recursive: true });
  await mkdir(measuredDir, { recursive: true });
  await Bun.write(join(outDir, 'run-config.json'), JSON.stringify(options, null, 2));
  await Bun.write(join(outDir, 'README.txt'), 'Meristem benchmark pack outputs.\n');

  console.log(`[benchmark:run:pack] outDir=${outDir}`);
  console.log(
    `[benchmark:run:pack] warmupRounds=${options.warmupRounds}, measuredRounds=${options.rounds}, intervalMs=${options.intervalMs}`,
  );

  // 这段 warmup 执行逻辑用于先让运行时和热点路径进入稳定状态，warmup 样本只落盘留档但不参与最终统计。
  for (let round = 1; round <= options.warmupRounds; round += 1) {
    console.log(`[benchmark:run:pack] warmup round ${round}/${options.warmupRounds}`);
    const output = runCommand(['bun', 'run', toolingCliPath, 'bench', 'baseline', '--single-sample'], coreDir);
    const report = parseBaselineReport(output, `warmup round ${round}`);
    await Bun.write(join(warmupDir, `run${round}.json`), JSON.stringify(report, null, 2));
    if (round < options.warmupRounds && options.intervalMs > 0) {
      await Bun.sleep(options.intervalMs);
    }
  }

  // 这段 measured 执行逻辑只记录固定轮次样本，并基于这些样本计算 median/trimmed mean，避免单次高点或低点扭曲结论。
  for (let round = 1; round <= options.rounds; round += 1) {
    console.log(`[benchmark:run:pack] measured round ${round}/${options.rounds}`);
    const output = runCommand(['bun', 'run', toolingCliPath, 'bench', 'baseline', '--single-sample'], coreDir);
    const report = parseBaselineReport(output, `measured round ${round}`);
    await Bun.write(join(measuredDir, `run${round}.json`), JSON.stringify(report, null, 2));
    for (const sample of report.samples) {
      const bucket = baselineBuckets.get(sample.name) ?? [];
      bucket.push(sample.opsPerSecond);
      baselineBuckets.set(sample.name, bucket);
    }
    if (round < options.rounds && options.intervalMs > 0) {
      await Bun.sleep(options.intervalMs);
    }
  }

  const comparisonSource = await maybeLoadComparisonSource(options, coreDir);

  const baselineSummary: BaselineSummaryItem[] = [...baselineBuckets.entries()]
    .sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
    .map(([name, values]) => {
      const stats = calculateStats(values);
      const comparison = buildComparison(stats, name, comparisonSource);
      return {
        name,
        stats,
        comparison,
      };
    });

  // 逻辑块：门禁输入以“多轮统计摘要”为唯一来源，不再读取单次样本。
  // 这样 median 回归与 CV 判定都基于相同轮次窗口，避免口径漂移导致的误报/漏报。
  const gate = evaluateBenchmarkGate(
    baselineSummary.map((item) => ({
      name: item.name,
      coefficientOfVariation: item.stats.coefficientOfVariation,
      medianDeltaPct: item.comparison?.medianDeltaPct ?? null,
    })),
    comparisonSource !== null,
    {
      maxCv: options.gateMaxCv,
      maxMedianRegressionPct: options.gateMaxMedianRegressionPct,
      requireComparison: options.gateRequireComparison,
    },
  );

  const runtime = scenarioAdapter.collectRuntimeMeta();

  const baselineProfile: BaselineProfile = {
    generatedAt: new Date().toISOString(),
    runtime,
    options: {
      warmupRounds: options.warmupRounds,
      rounds: options.rounds,
      intervalMs: options.intervalMs,
    },
    metrics: baselineSummary.map((item) => ({
      name: item.name,
      rounds: item.stats.rounds,
      medianOpsPerSecond: item.stats.medianOpsPerSecond,
      trimmedMeanOpsPerSecond: item.stats.trimmedMeanOpsPerSecond,
      minOpsPerSecond: item.stats.minOpsPerSecond,
      maxOpsPerSecond: item.stats.maxOpsPerSecond,
      coefficientOfVariation: item.stats.coefficientOfVariation,
    })),
  };

  await Bun.write(baselineProfilePath, JSON.stringify(baselineProfile, null, 2));

  let httpOutputPath: string | null = null;
  if (options.withHttp) {
    /*
      这段可选 HTTP 压测逻辑复用现有矩阵脚本，并在 pack 侧做额外结果校验：
      1) 先执行矩阵脚本并落盘原始结果；
      2) 再按适配器规则校验每个目标至少存在成功请求。
      这样可以在 Core 未启动或目标不可达时快速失败，避免生成“看似成功、实际无效”的压测结论。
    */
    const httpCommand = [
      'bun',
      'run',
      toolingCliPath, 'bench', 'http-matrix',
      '--requests',
      String(options.httpRequests),
      '--concurrency',
      String(options.httpConcurrency),
      '--warmup',
      String(options.httpWarmup),
      '--timeout-ms',
      String(options.httpTimeoutMs),
    ];
    if (options.httpTargets !== null) {
      httpCommand.push('--targets', options.httpTargets);
    }
    httpCommand.push('--out', httpOutPath);
    console.log(`[benchmark:run:pack] http matrix => ${httpOutPath}`);
    const httpMatrixOutput = runCommand(httpCommand, coreDir);
    const httpMatrixReport = parseHttpMatrixReport(httpMatrixOutput, httpOutPath);
    scenarioAdapter.validateHttpMatrixInvariants({
      source: httpOutPath,
      targets: httpMatrixReport.targets,
    });
    httpOutputPath = httpOutPath;
  }

  let reliabilityOutputPath: string | null = null;
  if (options.withReliability) {
    // 这段可选可靠性执行逻辑通过场景 adapter 触发，避免 benchmark pack 与具体仓库命令耦合。
    const reliabilityExecution = scenarioAdapter.runReliabilityE2E({
      repoRoot,
      runCommand,
    });
    console.log(`[benchmark:run:pack] reliability e2e => ${reliabilityLogPath}`);
    scenarioAdapter.validatePostRunInvariants(reliabilityExecution);
    await Bun.write(reliabilityLogPath, reliabilityExecution.output);
    reliabilityOutputPath = reliabilityLogPath;
  }

  const archivePath = options.archive ? `${outDir}.tar.gz` : null;
  if (archivePath) {
    // 这段归档逻辑把整轮评测结果固化成单文件，便于跨环境传输并避免遗漏中间文件。
    runCommand(['tar', '-czf', archivePath, '-C', dirname(outDir), basename(outDir)], coreDir);
  }

  const report: PackReport = {
    generatedAt: new Date().toISOString(),
    runtime,
    options: {
      warmupRounds: options.warmupRounds,
      rounds: options.rounds,
      intervalMs: options.intervalMs,
      withHttp: options.withHttp,
      withReliability: options.withReliability,
      archive: options.archive,
      comparePath: options.comparePath,
      profileOut: options.profileOut,
      comparisonMode: comparisonSource?.mode ?? 'none',
      comparisonResolvedPath: comparisonSource?.sourcePath ?? null,
      gateMaxCv: options.gateMaxCv,
      gateMaxMedianRegressionPct: options.gateMaxMedianRegressionPct,
      gateRequireComparison: options.gateRequireComparison,
    },
    paths: {
      outDir,
      warmupDir,
      measuredDir,
      baselineProfileJson: baselineProfilePath,
      summaryJson: summaryJsonPath,
      summaryMd: summaryMdPath,
      httpMatrixJson: httpOutputPath,
      reliabilityLog: reliabilityOutputPath,
      archive: archivePath,
    },
    baseline: baselineSummary,
    http: {
      enabled: options.withHttp,
      command: (() => {
        const command = [
          'bun',
          'run',
          toolingCliPath, 'bench', 'http-matrix',
          '--requests',
          String(options.httpRequests),
          '--concurrency',
          String(options.httpConcurrency),
          '--warmup',
          String(options.httpWarmup),
          '--timeout-ms',
          String(options.httpTimeoutMs),
        ];
        if (options.httpTargets !== null) {
          command.push('--targets', options.httpTargets);
        }
        command.push('--out', httpOutPath);
        return command;
      })(),
      outputPath: httpOutputPath,
    },
    reliability: {
      enabled: options.withReliability,
      command: scenarioAdapter.reliabilityCommand,
      logPath: reliabilityOutputPath,
    },
    gate,
  };

  const markdown = buildSummaryMarkdown(report);
  await Bun.write(summaryJsonPath, JSON.stringify(report, null, 2));
  await Bun.write(summaryMdPath, markdown);

  console.log(`[benchmark:run:pack] summary json => ${summaryJsonPath}`);
  console.log(`[benchmark:run:pack] summary md   => ${summaryMdPath}`);
  if (archivePath) {
    console.log(`[benchmark:run:pack] archive      => ${archivePath}`);
  }
  if (!gate.passed) {
    const preview = gate.violations
      .slice(0, 3)
      .map((violation) => `${violation.metric}:${violation.rule}`)
      .join(', ');
    throw new Error(
      `benchmark gate failed with ${gate.violations.length} violation(s)` +
        (preview.length > 0 ? ` (${preview})` : ''),
    );
  }
};

if (import.meta.main) {
  runBenchmarkPackCommand(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[benchmark:run:pack] failed: ${message}`);
    process.exit(1);
  });
}
