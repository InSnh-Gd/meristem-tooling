import { runWasmPocBenchmarks, type WasmPocBenchmarkResult } from '../bench/wasm-poc';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
  const ioPayload = new TextEncoder().encode(JSON.stringify(payload).repeat(128));
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

  /**
   * 逻辑块：新增“磁盘 vs 内存文件系统”对照测量，用于判断瓶颈是否主要来自磁盘 I/O。
   * 这里固定 payload 与迭代次数，先测工作区磁盘，再在可用时测 /dev/shm（内存文件系统）。
   * 若宿主机不存在 /dev/shm 或权限不足，降级为只保留磁盘样本，避免基准流程因环境差异中断。
   */
  const workspaceTmpDir = resolve(process.cwd(), '.codex', 'tmp');
  samples.push(runFileIoBenchmark('file-io-workspace-disk', 800, workspaceTmpDir, ioPayload));

  if (existsSync('/dev/shm')) {
    try {
      samples.push(runFileIoBenchmark('file-io-dev-shm', 800, '/dev/shm', ioPayload));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[tooling:bench:baseline] skip /dev/shm sample: ${message}`);
      const osTmpDir = tmpdir();
      if (osTmpDir !== workspaceTmpDir) {
        samples.push(runFileIoBenchmark('file-io-os-tmp', 800, osTmpDir, ioPayload));
      }
    }
  } else {
    const osTmpDir = tmpdir();
    if (osTmpDir !== workspaceTmpDir) {
      samples.push(runFileIoBenchmark('file-io-os-tmp', 800, osTmpDir, ioPayload));
    }
  }

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
