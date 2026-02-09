#!/usr/bin/env bun

import {
  CORE_DIR,
  CLIENT_DIR,
  SHARED_DIR,
  fetchText,
  readLogText,
  readRuntimeState,
  resetClientCredentials,
  runCompose,
  runCommand,
  startBackgroundProcess,
  waitFor,
  writeRuntimeState,
} from './lib';
import { runPreflight } from './preflight';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const composeFileArgs = ['-f', 'docker-compose.test.yml'] as const;

const ensureSharedBuild = (): void => {
  const build = runCommand('bun', ['run', 'build'], { cwd: SHARED_DIR });
  if (build.code !== 0) {
    throw new Error(`[shared build] failed\n${build.stdout}\n${build.stderr}`);
  }

  const buildTypes = runCommand('bun', ['run', 'build-types'], { cwd: SHARED_DIR });
  if (buildTypes.code !== 0) {
    throw new Error(`[shared build-types] failed\n${buildTypes.stdout}\n${buildTypes.stderr}`);
  }
};

const waitForNatsMonitor = async (): Promise<void> => {
  await waitFor(
    async () => {
      try {
        const text = await fetchText('http://localhost:8222/varz');
        return text.includes('jetstream');
      } catch {
        return false;
      }
    },
    30_000,
    1_000,
    'nats monitor'
  );
};

const waitForCoreHealth = async (coreUrl: string): Promise<void> => {
  await waitFor(
    async () => {
      try {
        const response = await fetch(`${coreUrl}/health`);
        return response.ok;
      } catch {
        return false;
      }
    },
    45_000,
    1_000,
    'core health'
  );
};

const waitForClientJoinSignal = async (clientLogFile: string): Promise<void> => {
  const credentialsPath = path.join(CLIENT_DIR, '.meristem', 'credentials.json');

  await waitFor(
    () => {
      const logText = readLogText(clientLogFile);
      if (logText.includes('[Join] Success! Node ID:')) {
        return true;
      }

      if (!existsSync(credentialsPath)) {
        return false;
      }

      try {
        const raw = readFileSync(credentialsPath, 'utf-8');
        return raw.includes('\"node_id\"');
      } catch {
        return false;
      }
    },
    45_000,
    1_000,
    'client join success'
  );
};

export const runE2E = async (): Promise<void> => {
  await runPreflight();
  const base = readRuntimeState();

  ensureSharedBuild();

  runCompose([...composeFileArgs, 'up', '-d'], 'docker compose up');
  await waitForNatsMonitor();

  resetClientCredentials();

  const corePid = startBackgroundProcess('bun', ['run', 'src/index.ts'], {
    cwd: CORE_DIR,
    env: {
      MERISTEM_NATS_URL: base.natsUrl,
      MERISTEM_DATABASE_MONGO_URI: base.mongoUri,
      MERISTEM_SERVER_PORT: '3000',
    },
    logFile: base.logs.core,
  });

  await waitForCoreHealth(base.coreUrl);

  const clientPid = startBackgroundProcess('bun', ['run', 'src/index.ts'], {
    cwd: CLIENT_DIR,
    env: {
      MERISTEM_CORE_URL: base.coreUrl,
      MERISTEM_NATS_URL: base.natsUrl,
    },
    logFile: base.logs.client,
  });

  await waitForClientJoinSignal(base.logs.client);

  writeRuntimeState({
    ...base,
    pids: {
      core: corePid,
      client: clientPid,
    },
  });
};

if (import.meta.main) {
  try {
    await runE2E();
    const state = readRuntimeState();
    console.log('[e2e:run] ok');
    console.log(`[e2e:run] core_pid=${state.pids.core ?? 'none'}`);
    console.log(`[e2e:run] client_pid=${state.pids.client ?? 'none'}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[e2e:run] failed: ${message}`);
    process.exit(1);
  }
}
