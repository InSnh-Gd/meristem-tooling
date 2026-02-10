export type HttpMethod = 'GET' | 'POST';

export type HttpBenchmarkBodyFactoryContext = {
  requestIndex: number;
};

export type HttpBenchmarkBodyFactory = (
  context: HttpBenchmarkBodyFactoryContext,
) => unknown;

export type HttpBenchmarkTarget = {
  name: string;
  url: string;
  method: HttpMethod;
  headers?: Readonly<Record<string, string>>;
  body?: unknown | HttpBenchmarkBodyFactory;
};

export type HttpBenchmarkConfig = {
  warmupRequests: number;
  requests: number;
  concurrency: number;
  timeoutMs: number;
};

export type LatencyStats = {
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
};

export type HttpBenchmarkMetrics = {
  requests: number;
  success: number;
  failures: number;
  errorRate: number;
  throughputRps: number;
  successThroughputRps: number;
  latency: LatencyStats;
};

export type HttpBenchmarkResult = {
  target: HttpBenchmarkTarget;
  metrics: HttpBenchmarkMetrics;
};

export type HttpBenchmarkRawResult = {
  target: HttpBenchmarkTarget;
  latenciesMs: readonly number[];
  successCount: number;
  failureCount: number;
  totalDurationMs: number;
};

export type HttpBenchmarkResponseSnapshot = {
  status: number;
  body: unknown;
};

export type HttpBenchmarkSuccessClassifier = (
  target: HttpBenchmarkTarget,
  response: HttpBenchmarkResponseSnapshot,
) => boolean;

export type ThroughputRankingItem = {
  rank: number;
  name: string;
  successThroughputRps: number;
  throughputRps: number;
  errorRate: number;
  p95LatencyMs: number;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const clampToNonNegative = (value: number): number => (value > 0 ? value : 0);

const percentile = (sorted: readonly number[], ratio: number): number => {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
};

export const computeLatencyStats = (samples: readonly number[]): LatencyStats => {
  if (samples.length === 0) {
    return {
      min: 0,
      max: 0,
      avg: 0,
      p50: 0,
      p95: 0,
      p99: 0,
    };
  }

  const sorted = [...samples].sort((left, right) => left - right);
  const total = sorted.reduce((sum, item) => sum + item, 0);

  return {
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    avg: total / sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  };
};

export const summarizeHttpBenchmarkResult = (raw: HttpBenchmarkRawResult): HttpBenchmarkResult => {
  const requests = raw.successCount + raw.failureCount;
  const errorRate = requests === 0 ? 0 : raw.failureCount / requests;
  const throughputRps = raw.totalDurationMs <= 0 ? 0 : requests / (raw.totalDurationMs / 1000);
  const successThroughputRps = raw.totalDurationMs <= 0 ? 0 : raw.successCount / (raw.totalDurationMs / 1000);

  return {
    target: raw.target,
    metrics: {
      requests,
      success: raw.successCount,
      failures: raw.failureCount,
      errorRate,
      throughputRps,
      successThroughputRps,
      latency: computeLatencyStats(raw.latenciesMs),
    },
  };
};

export const buildThroughputRanking = (results: readonly HttpBenchmarkResult[]): ThroughputRankingItem[] =>
  [...results]
    .sort((left, right) => {
      if (right.metrics.successThroughputRps !== left.metrics.successThroughputRps) {
        return right.metrics.successThroughputRps - left.metrics.successThroughputRps;
      }
      if (left.metrics.errorRate !== right.metrics.errorRate) {
        return left.metrics.errorRate - right.metrics.errorRate;
      }
      if (right.metrics.throughputRps !== left.metrics.throughputRps) {
        return right.metrics.throughputRps - left.metrics.throughputRps;
      }
      return left.metrics.latency.p95 - right.metrics.latency.p95;
    })
    .map((result, index) => ({
      rank: index + 1,
      name: result.target.name,
      successThroughputRps: result.metrics.successThroughputRps,
      throughputRps: result.metrics.throughputRps,
      errorRate: result.metrics.errorRate,
      p95LatencyMs: result.metrics.latency.p95,
    }));

const withTimeoutSignal = (timeoutMs: number): AbortSignal => {
  const resolvedTimeout = Math.max(1, Math.floor(timeoutMs));
  return AbortSignal.timeout(resolvedTimeout);
};

const resolveRequestBody = (
  body: HttpBenchmarkTarget['body'],
  requestIndex: number,
): unknown => {
  if (typeof body === 'function') {
    return body({ requestIndex });
  }
  return body;
};

const buildRequestInit = (
  target: HttpBenchmarkTarget,
  timeoutMs: number,
  requestIndex: number,
): RequestInit => {
  const resolvedBody = resolveRequestBody(target.body, requestIndex);
  const hasBody = resolvedBody !== undefined;
  const headers =
    !hasBody
      ? target.headers
      : {
          'content-type': 'application/json',
          ...(target.headers ?? {}),
        };

  return {
    method: target.method,
    headers,
    body: !hasBody ? undefined : JSON.stringify(resolvedBody),
    signal: withTimeoutSignal(timeoutMs),
  };
};

const parseResponseBody = async (response: Response): Promise<unknown> => {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('application/json')) {
    return null;
  }
  try {
    return (await response.clone().json()) as unknown;
  } catch {
    return null;
  }
};

const runSingleRequest = async (
  target: HttpBenchmarkTarget,
  timeoutMs: number,
  requestIndex: number,
  fetcher: FetchLike,
  classifySuccess?: HttpBenchmarkSuccessClassifier,
): Promise<{
  ok: boolean;
  durationMs: number;
}> => {
  const requestInit = buildRequestInit(target, timeoutMs, requestIndex);
  const startedAt = performance.now();

  try {
    const response = await fetcher(target.url, requestInit);
    const durationMs = performance.now() - startedAt;
    if (!classifySuccess) {
      return {
        ok: response.ok,
        durationMs,
      };
    }
    const body = await parseResponseBody(response);
    let ok = false;
    try {
      ok = classifySuccess(target, {
        status: response.status,
        body,
      });
    } catch {
      ok = false;
    }
    return {
      ok,
      durationMs,
    };
  } catch {
    return {
      ok: false,
      durationMs: performance.now() - startedAt,
    };
  }
};

const runWorker = async (
  state: {
    nextRequest: number;
  },
  target: HttpBenchmarkTarget,
  totalRequests: number,
  timeoutMs: number,
  fetcher: FetchLike,
  classifySuccess?: HttpBenchmarkSuccessClassifier,
): Promise<{
  latencies: number[];
  successCount: number;
  failureCount: number;
}> => {
  const latencies: number[] = [];
  let successCount = 0;
  let failureCount = 0;

  while (state.nextRequest < totalRequests) {
    const requestIndex = state.nextRequest;
    state.nextRequest += 1;
    const result = await runSingleRequest(
      target,
      timeoutMs,
      requestIndex,
      fetcher,
      classifySuccess,
    );
    latencies.push(clampToNonNegative(result.durationMs));
    if (result.ok) {
      successCount += 1;
    } else {
      failureCount += 1;
    }
  }

  return {
    latencies,
    successCount,
    failureCount,
  };
};

const mergeWorkerResults = (
  items: readonly {
    latencies: readonly number[];
    successCount: number;
    failureCount: number;
  }[],
): {
  latenciesMs: number[];
  successCount: number;
  failureCount: number;
} => {
  const latenciesMs: number[] = [];
  let successCount = 0;
  let failureCount = 0;

  for (const item of items) {
    latenciesMs.push(...item.latencies);
    successCount += item.successCount;
    failureCount += item.failureCount;
  }

  return {
    latenciesMs,
    successCount,
    failureCount,
  };
};

export const runHttpBenchmarkTarget = async (
  target: HttpBenchmarkTarget,
  config: HttpBenchmarkConfig,
  fetcher: FetchLike = fetch,
  classifySuccess?: HttpBenchmarkSuccessClassifier,
): Promise<HttpBenchmarkResult> => {
  const warmupRequests = Math.max(0, Math.floor(config.warmupRequests));
  const requests = Math.max(1, Math.floor(config.requests));
  const concurrency = Math.max(1, Math.floor(config.concurrency));
  const timeoutMs = Math.max(100, Math.floor(config.timeoutMs));

  for (let index = 0; index < warmupRequests; index += 1) {
    await runSingleRequest(target, timeoutMs, index, fetcher, classifySuccess);
  }

  const state = {
    nextRequest: 0,
  };

  const startedAt = performance.now();
  const workers = Array.from({ length: concurrency }, () =>
    runWorker(state, target, requests, timeoutMs, fetcher, classifySuccess),
  );
  const workerResults = await Promise.all(workers);
  const totalDurationMs = performance.now() - startedAt;
  const merged = mergeWorkerResults(workerResults);

  return summarizeHttpBenchmarkResult({
    target,
    ...merged,
    totalDurationMs,
  });
};

export const runHttpBenchmarkMatrix = async (
  targets: readonly HttpBenchmarkTarget[],
  config: HttpBenchmarkConfig,
  fetcher: FetchLike = fetch,
  classifySuccess?: HttpBenchmarkSuccessClassifier,
): Promise<{
  results: HttpBenchmarkResult[];
  ranking: ThroughputRankingItem[];
}> => {
  const results: HttpBenchmarkResult[] = [];

  for (const target of targets) {
    const result = await runHttpBenchmarkTarget(target, config, fetcher, classifySuccess);
    results.push(result);
  }

  return {
    results,
    ranking: buildThroughputRanking(results),
  };
};
