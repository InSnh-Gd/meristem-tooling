import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export const DEFAULT_TEST_ARTIFACT_ROOT = 'meristem-test-output';
const DEFAULT_TIMESTAMP_DIR_PREFIX = 'meristem-test-output';

const hasWorkspaceShape = (root: string): boolean =>
  existsSync(join(root, 'meristem-core'))
  && existsSync(join(root, 'meristem-client'))
  && existsSync(join(root, 'meristem-shared'));

/**
 * 逻辑块：工作区根目录推断。
 * - 优先级：显式环境变量 > 当前目录 > 当前目录父级（兼容在 meristem-tooling 子仓直接执行）。
 * - 目的：减少本地手动设置 MERISTEM_WORKSPACE_ROOT 的心智负担。
 * - 失败路径：若候选均不满足多仓结构，则回退当前目录并由后续命令给出缺失路径错误。
 */
export const resolveWorkspaceRoot = (): string => {
  const envRoot = process.env.MERISTEM_WORKSPACE_ROOT;
  if (envRoot && envRoot.trim().length > 0) {
    return resolve(envRoot);
  }

  const cwd = resolve(process.cwd());
  if (hasWorkspaceShape(cwd)) {
    return cwd;
  }

  const parent = resolve(cwd, '..');
  if (hasWorkspaceShape(parent)) {
    return parent;
  }

  return cwd;
};

const normalizeOverridePath = (workspaceRoot: string, rawOverride: string): string => {
  const trimmed = rawOverride.trim();
  if (trimmed.length === 0) {
    return join(workspaceRoot, DEFAULT_TEST_ARTIFACT_ROOT);
  }

  /**
   * 逻辑块：产物目录覆盖遵循“绝对路径直用、相对路径锚定工作区”。
   * 这样既允许 CI 指向独立卷，也避免本地传相对路径时漂移到未知 cwd。
   * 若输入为空串则回退默认目录，保证命令在未配置环境变量时可稳定运行。
   */
  if (isAbsolute(trimmed)) {
    return resolve(trimmed);
  }
  return resolve(workspaceRoot, trimmed);
};

export const resolveTestArtifactRoot = (): string => {
  const workspaceRoot = resolveWorkspaceRoot();
  const override = process.env.MERISTEM_TEST_ARTIFACT_ROOT;
  if (override) {
    return normalizeOverridePath(workspaceRoot, override);
  }
  return join(workspaceRoot, DEFAULT_TEST_ARTIFACT_ROOT);
};

export const resolveTestArtifactPath = (...segments: readonly string[]): string =>
  join(resolveTestArtifactRoot(), ...segments);

export const createTimestampedTestArtifactDir = (prefix: string): string => {
  const normalizedPrefix = prefix.trim().length === 0 ? DEFAULT_TIMESTAMP_DIR_PREFIX : prefix.trim();
  return resolveTestArtifactPath(`${normalizedPrefix}-${Date.now()}`);
};
