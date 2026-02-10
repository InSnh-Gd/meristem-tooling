import { describe, expect, test } from 'bun:test';
import {
  resolveTestArtifactRoot,
  resolveTestArtifactPath,
  createTimestampedTestArtifactDir,
} from './test-artifacts.ts';

const withEnv = (key: string, value: string | undefined, fn: () => void): void => {
  const previous = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }

  try {
    fn();
  } finally {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
};

describe('test artifact path resolver', () => {
  test('uses workspace-root anchored meristem-test output by default', () => {
    withEnv('MERISTEM_WORKSPACE_ROOT', '/repo/workspace', () => {
      withEnv('MERISTEM_TEST_ARTIFACT_ROOT', undefined, () => {
        expect(resolveTestArtifactRoot()).toBe('/repo/workspace/meristem-test-output');
      });
    });
  });

  test('resolves relative override against workspace root', () => {
    withEnv('MERISTEM_WORKSPACE_ROOT', '/repo/workspace', () => {
      withEnv('MERISTEM_TEST_ARTIFACT_ROOT', 'meristem-test-custom', () => {
        expect(resolveTestArtifactRoot()).toBe('/repo/workspace/meristem-test-custom');
      });
    });
  });

  test('keeps absolute override as-is', () => {
    withEnv('MERISTEM_WORKSPACE_ROOT', '/repo/workspace', () => {
      withEnv('MERISTEM_TEST_ARTIFACT_ROOT', '/tmp/meristem-test-override', () => {
        expect(resolveTestArtifactRoot()).toBe('/tmp/meristem-test-override');
      });
    });
  });

  test('joins nested segments under resolved test artifact root', () => {
    withEnv('MERISTEM_WORKSPACE_ROOT', '/repo/workspace', () => {
      withEnv('MERISTEM_TEST_ARTIFACT_ROOT', undefined, () => {
        expect(resolveTestArtifactPath('meristem-test-e2e-runtime', 'runtime.json')).toBe(
          '/repo/workspace/meristem-test-output/meristem-test-e2e-runtime/runtime.json',
        );
      });
    });
  });

  test('creates timestamp directory name with meristem-test prefix', () => {
    const originalNow = Date.now;
    Date.now = () => 1_730_000_000_000;
    try {
      withEnv('MERISTEM_WORKSPACE_ROOT', '/repo/workspace', () => {
        withEnv('MERISTEM_TEST_ARTIFACT_ROOT', undefined, () => {
          expect(createTimestampedTestArtifactDir('meristem-test-pack')).toBe(
            '/repo/workspace/meristem-test-output/meristem-test-pack-1730000000000',
          );
        });
      });
    } finally {
      Date.now = originalNow;
    }
  });
});
