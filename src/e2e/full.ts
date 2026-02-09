#!/usr/bin/env bun

import { assertE2E } from './assert';
import { cleanupE2E } from './cleanup';
import { runPreflight } from './preflight';
import { runE2E } from './run';

/**
 * 逻辑块：workspace 层串行编排完整 E2E 流程。
 * 该函数只定义流程顺序（preflight -> run -> assert），不承载步骤内部业务细节。
 * 任一步骤抛错都向上冒泡，由主入口统一记录失败并设置退出码。
 */
export const fullE2E = async (): Promise<void> => {
  await runPreflight();
  await runE2E();
  await assertE2E();
};

export const runFullE2EWithCleanup = async (): Promise<void> => {
  /**
   * 逻辑块：对外统一暴露“带清理”的完整 E2E 入口。
   * 这样无论是 CLI 调用还是脚本调用，都能在失败路径回收进程与容器状态，
   * 避免脏环境影响后续压测或可靠性轮次。
   */
  try {
    await fullE2E();
    console.log('[e2e] pass');
  } finally {
    await cleanupE2E();
  }
};

if (import.meta.main) {
  try {
    await runFullE2EWithCleanup();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[e2e] failed: ${message}`);
    process.exitCode = 1;
  }
}
