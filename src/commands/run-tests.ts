#!/usr/bin/env bun

import { spawn } from 'node:child_process';

const isNatsAvailable = (): boolean => {
  return process.env.NATS_URL !== undefined && process.env.NATS_URL !== '';
};

export const runWorkspaceTests = async (): Promise<number> => {
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
