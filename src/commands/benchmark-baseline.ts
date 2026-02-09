import { runWasmPocBenchmarks, type WasmPocBenchmarkResult } from '../bench/wasm-poc';

type BenchmarkSample = {
  name: string;
  iterations: number;
  durationMs: number;
  opsPerSecond: number;
};

export type BaselineReport = {
  generatedAt: string;
  runtime: {
    bunVersion: string;
    platform: string;
    arch: string;
  };
  samples: readonly BenchmarkSample[];
  wasmPoc: WasmPocBenchmarkResult;
};

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

export const runBaselineReport = (): BaselineReport => {
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
  const wasmPoc = runWasmPocBenchmarks({
    iterations: 600,
  });

  const samples: BenchmarkSample[] = [
    runBenchmark('json-stringify-parse', 20_000, () => {
      const encoded = JSON.stringify(payload);
      const decoded = JSON.parse(encoded) as Record<string, unknown>;
      if (!decoded.node_id) {
        throw new Error('invalid decode');
      }
    }),
    runBenchmark('uint8array-copy', 50_000, () => {
      const copied = byteSource.slice();
      if (copied.byteLength !== byteSource.byteLength) {
        throw new Error('invalid copy');
      }
    }),
    runBenchmark('text-encode-decode', 50_000, () => {
      const encoded = new TextEncoder().encode('meristem-benchmark');
      const decoded = new TextDecoder().decode(encoded);
      if (decoded.length === 0) {
        throw new Error('invalid text decode');
      }
    }),
  ];

  return {
    generatedAt: new Date().toISOString(),
    runtime: {
      bunVersion: Bun.version,
      platform: process.platform,
      arch: process.arch,
    },
    samples,
    wasmPoc,
  };
};

export const runBaselineCommand = async (argv: readonly string[] = []): Promise<void> => {
  const args = [...argv];
  let outPath: string | null = null;

  while (args.length > 0) {
    const token = args.shift();
    if (token === '--out') {
      outPath = args.shift() ?? null;
      continue;
    }
    if (token === '--help') {
      console.log('Usage: tooling bench baseline [--out <path>]');
      return;
    }
    throw new Error(`unknown option: ${token}`);
  }

  const report = runBaselineReport();
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
