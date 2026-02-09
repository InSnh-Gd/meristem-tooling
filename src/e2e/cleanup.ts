#!/usr/bin/env bun

import { readRuntimeState, runCompose, stopProcess, type RuntimeState } from './lib';
import { CLIENT_DIR } from './lib';
import { rmSync } from 'node:fs';
import path from 'node:path';

const composeFileArgs = ['-f', 'docker-compose.test.yml'] as const;

export const cleanupE2E = async (): Promise<void> => {
  let state: RuntimeState | null;
  try {
    state = readRuntimeState();
  } catch {
    state = null;
  }

  if (state?.pids.client) {
    stopProcess(state.pids.client);
  }

  if (state?.pids.core) {
    stopProcess(state.pids.core);
  }

  runCompose([...composeFileArgs, 'down'], 'docker compose down');
  rmSync(path.join(CLIENT_DIR, '.meristem'), { recursive: true, force: true });
};

if (import.meta.main) {
  try {
    await cleanupE2E();
    console.log('[e2e:cleanup] ok');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[e2e:cleanup] failed: ${message}`);
    process.exit(1);
  }
}
