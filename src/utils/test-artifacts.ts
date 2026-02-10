import { isAbsolute, join, resolve } from 'node:path';

export const DEFAULT_TEST_ARTIFACT_ROOT = 'meristem-test-output';
const DEFAULT_TIMESTAMP_DIR_PREFIX = 'meristem-test-output';

export const resolveWorkspaceRoot = (): string =>
  resolve(process.env.MERISTEM_WORKSPACE_ROOT ?? process.cwd());

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
