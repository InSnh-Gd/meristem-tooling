import type {
  HttpBenchmarkBodyFactoryContext,
  HttpBenchmarkResponseSnapshot,
  HttpBenchmarkSuccessClassifier,
  HttpBenchmarkTarget,
} from './http-benchmark';

type RuntimeMeta = {
  bunVersion: string;
  bunRevision: string | null;
  platform: string;
  arch: string;
};

type ReliabilityExecution = {
  command: readonly string[];
  output: string;
};

type ReliabilityRunInput = {
  repoRoot: string;
  runCommand: (command: readonly string[], cwd: string) => string;
};

export type HttpMatrixTargetStats = {
  name: string;
  requests: number;
  success: number;
  failures: number;
  errorRate: number;
};

export type JoinBenchmarkMode = 'same-hwid' | 'unique-hwid';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const getBunRevision = (): string | null => {
  const runtime = Bun as unknown as { revision?: unknown };
  return typeof runtime.revision === 'string' ? runtime.revision : null;
};

const readResponseSuccess = (body: unknown): boolean | null => {
  if (!isRecord(body)) {
    return null;
  }
  const success = body.success;
  return typeof success === 'boolean' ? success : null;
};

const DEFAULT_RELIABILITY_COMMAND = ['bun', 'run', 'tooling:e2e:run:workspace'] as const;
const DEFAULT_JOIN_HWID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const buildUniqueJoinHwid = (requestIndex: number): string => {
  const suffix = (requestIndex + 1).toString(16).padStart(16, '0');
  return `${'b'.repeat(48)}${suffix}`;
};

export type CoreScenarioAdapter = {
  readonly reliabilityCommand: readonly string[];
  readonly joinMode: JoinBenchmarkMode;
  collectRuntimeMeta: () => RuntimeMeta;
  buildTargets: (coreBaseUrl: string) => readonly HttpBenchmarkTarget[];
  classifySuccess: HttpBenchmarkSuccessClassifier;
  validateHttpMatrixInvariants: (input: {
    source: string;
    targets: readonly HttpMatrixTargetStats[];
  }) => void;
  runReliabilityE2E: (input: ReliabilityRunInput) => ReliabilityExecution;
  validatePostRunInvariants: (execution: ReliabilityExecution) => void;
};

export const createCoreScenarioAdapter = (
  options: { joinMode?: JoinBenchmarkMode } = {},
): CoreScenarioAdapter => {
  const joinMode = options.joinMode ?? 'same-hwid';

  return {
    reliabilityCommand: DEFAULT_RELIABILITY_COMMAND,
    joinMode,
    collectRuntimeMeta: (): RuntimeMeta => ({
      bunVersion: Bun.version,
      bunRevision: getBunRevision(),
      platform: process.platform,
      arch: process.arch,
    }),
    buildTargets: (coreBaseUrl: string): readonly HttpBenchmarkTarget[] => [
      {
        name: 'core-health',
        url: `${coreBaseUrl}/health`,
        method: 'GET',
      },
      {
        name: 'core-join',
        url: `${coreBaseUrl}/api/v1/join`,
        method: 'POST',
        headers: {
          'x-trace-id': 'benchmark-trace',
        },
        /**
         * 逻辑块：join 压测分离为冲突模式与吞吐模式。
         * - same-hwid：固定 HWID，专门放大热点冲突，观察事务竞争与退避效果；
         * - unique-hwid：每请求唯一 HWID，评估系统纯吞吐上限，避免冲突噪音掩盖真实容量。
         */
        body:
          joinMode === 'unique-hwid'
            ? ({ requestIndex }: HttpBenchmarkBodyFactoryContext) => ({
                hwid: buildUniqueJoinHwid(requestIndex),
                hostname: `bench-node-${requestIndex}`,
                persona: 'AGENT',
                org_id: 'org-default',
              })
            : {
                hwid: DEFAULT_JOIN_HWID,
                hostname: 'bench-node',
                persona: 'AGENT',
                org_id: 'org-default',
              },
      },
    ],
    classifySuccess: (_target: HttpBenchmarkTarget, response: HttpBenchmarkResponseSnapshot): boolean => {
      if (response.status < 200 || response.status >= 300) {
        return false;
      }
      const declaredSuccess = readResponseSuccess(response.body);
      if (declaredSuccess === null) {
        return true;
      }
      return declaredSuccess;
    },
    validateHttpMatrixInvariants: (input): void => {
      /**
       * 逻辑块：矩阵结果前置校验用于阻断“脚本返回成功但目标全失败”的无效样本。
       * 一旦检测到请求数异常、错误率越界或 success=0，会立即失败，避免污染后续基线统计。
       */
      if (input.targets.length === 0) {
        throw new Error(`http matrix produced no targets (${input.source})`);
      }

      const invalidTargets = input.targets.filter((target) => {
        if (target.requests <= 0) {
          return true;
        }
        if (target.success < 0 || target.success > target.requests) {
          return true;
        }
        if (target.failures < 0 || target.failures > target.requests) {
          return true;
        }
        if (!Number.isFinite(target.errorRate) || target.errorRate < 0 || target.errorRate > 1) {
          return true;
        }
        return false;
      });

      if (invalidTargets.length > 0) {
        const targetNames = invalidTargets.map((target) => target.name).join(', ');
        throw new Error(`http matrix contains invalid metrics: ${targetNames} (${input.source})`);
      }

      const zeroSuccessTargets = input.targets
        .filter((target) => target.success === 0)
        .map((target) => target.name);

      if (zeroSuccessTargets.length > 0) {
        throw new Error(
          `http matrix has zero successful requests for targets: ${zeroSuccessTargets.join(', ')} (${input.source})`,
        );
      }
    },
    runReliabilityE2E: (input: ReliabilityRunInput): ReliabilityExecution => {
      const output = input.runCommand(DEFAULT_RELIABILITY_COMMAND, input.repoRoot);
      return {
        command: DEFAULT_RELIABILITY_COMMAND,
        output,
      };
    },
    validatePostRunInvariants: (execution: ReliabilityExecution): void => {
      if (!execution.output.includes('[e2e] pass')) {
        throw new Error('reliability e2e did not emit pass marker: [e2e] pass');
      }
    },
  };
};
