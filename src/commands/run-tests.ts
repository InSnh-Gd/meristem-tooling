#!/usr/bin/env bun

import { spawn } from 'node:child_process';

const isNatsAvailable = (): boolean => {
  return process.env.NATS_URL !== undefined && process.env.NATS_URL !== '';
};

const runStandardsSyncVerification = async (): Promise<number> => {
  const verifyProcess = spawn('bun', ['run', 'scripts/verify-standards-sync.ts'], {
    stdio: 'inherit',
    env: { ...process.env },
  });

  return new Promise((resolve) => {
    verifyProcess.on('close', (code) => {
      resolve(code ?? 1);
    });
  });
};

export const runWorkspaceTests = async (): Promise<number> => {
  /**
   * 逻辑块：先执行标准一致性门禁，再执行测试矩阵。
   * - 目的：在单测/集成测试之前拦截文档-实现常量漂移。
   * - 原因：Phase 2.5 要求把标准漂移转成可执行阻断项。
   * - 降级：校验失败立即返回非零退出码，不继续跑测试以避免误判。
   */
  const verifyCode = await runStandardsSyncVerification();
  if (verifyCode !== 0) {
    console.error('[tooling:test:workspace] standards sync verification failed');
    return verifyCode;
  }

  const hasNats = isNatsAvailable();

  if (!hasNats) {
    console.warn('⚠️  NATS_URL not set - integration tests will be skipped');
    console.warn('   To run integration tests, set NATS_URL environment variable');
    console.warn('   Example: export NATS_URL=nats://localhost:4222');
  } else {
    console.log('✅ NATS_URL detected - running all tests (unit + integration)');
  }

  const args = ['test'];

  /**
   * 逻辑块：workspace 测试编排采用“标签驱动降级”。
   * 当 NATS 不可用时，统一过滤 `@integration`，从而让 CI/本地缺依赖环境仍可执行稳定单测。
   */
  if (!hasNats) {
    args.push('--test-name-pattern');
    args.push('^(?!.*@integration).*');
  }

  const testProcess = spawn('bun', args, {
    stdio: 'inherit',
    env: { ...process.env },
  });

  return new Promise((resolve) => {
    testProcess.on('close', (code) => {
      resolve(code ?? 1);
    });
  });
};

if (import.meta.main) {
  runWorkspaceTests().then((code) => {
    process.exit(code);
  });
}
