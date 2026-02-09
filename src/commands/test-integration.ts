import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

type IntegrationSelection =
  | {
      mode: 'tag';
      args: readonly string[];
      description: string;
    }
  | {
      mode: 'files';
      args: readonly string[];
      description: string;
    };

const workspaceRoot = (): string => resolve(process.env.MERISTEM_WORKSPACE_ROOT ?? process.cwd());
const coreDir = (): string => join(workspaceRoot(), 'meristem-core');
const TEST_ROOT = (): string => join(coreDir(), 'src', '__tests__');
const INTEGRATION_TAG = '@integration';

const listFilesRecursively = (dir: string): string[] => {
  if (!existsSync(dir)) {
    return [];
  }
  const entries = readdirSync(dir);
  const output: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const st = statSync(fullPath);
    if (st.isDirectory()) {
      output.push(...listFilesRecursively(fullPath));
      continue;
    }
    output.push(fullPath);
  }
  return output;
};

const toCoreRelative = (absolutePath: string): string => {
  const base = coreDir();
  if (absolutePath.startsWith(`${base}/`)) {
    return absolutePath.slice(base.length + 1);
  }
  return absolutePath;
};

const hasIntegrationTag = (filePath: string): boolean => {
  if (!filePath.endsWith('.test.ts')) {
    return false;
  }
  const content = readFileSync(filePath, 'utf8');
  return content.includes(INTEGRATION_TAG);
};

const isIntegrationFile = (filePath: string): boolean =>
  filePath.endsWith('.test.ts') && filePath.toLowerCase().includes('integration');

const resolveSelection = (): IntegrationSelection => {
  const files = listFilesRecursively(TEST_ROOT());
  const taggedTests = files.filter(hasIntegrationTag);
  if (taggedTests.length > 0) {
    return {
      mode: 'tag',
      args: ['--test-name-pattern', '.*@integration.*'],
      description: `detected ${taggedTests.length} tagged test file(s)`,
    };
  }

  const integrationFiles = files.filter(isIntegrationFile).map(toCoreRelative).sort();
  if (integrationFiles.length === 0) {
    throw new Error('no integration tests found: missing @integration tags and *integration*.test.ts files');
  }

  return {
    mode: 'files',
    args: integrationFiles,
    description: `fallback to integration file set (${integrationFiles.length} file(s))`,
  };
};

export const runCoreIntegrationTestsCommand = async (_argv: readonly string[] = []): Promise<void> => {
  const selection = resolveSelection();

  /**
   * 逻辑块：集成测试入口遵循“标签优先、命名兜底”。
   * 这样可以在历史测试逐步补标签期间保持可执行，同时在没有任何命中的情况下直接失败，
   * 避免出现“脚本成功但实际没跑测试”的假阳性。
   */
  console.log(`[tooling:test:integration-core] mode=${selection.mode} (${selection.description})`);
  console.log(
    `[tooling:test:integration-core] NATS_URL=${process.env.NATS_URL ?? 'nats://localhost:4222'}`,
  );

  const result = Bun.spawnSync({
    cmd: ['bun', 'test', ...selection.args],
    cwd: coreDir(),
    stdout: 'inherit',
    stderr: 'inherit',
    env: {
      ...process.env,
      NATS_URL: process.env.NATS_URL ?? 'nats://localhost:4222',
    },
  });

  if (result.exitCode !== 0) {
    process.exit(result.exitCode);
  }
};

if (import.meta.main) {
  runCoreIntegrationTestsCommand().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[tooling:test:integration-core] failed: ${message}`);
    process.exit(1);
  });
}
