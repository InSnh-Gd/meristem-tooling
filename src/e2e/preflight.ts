#!/usr/bin/env bun

import {
  checkCommandExists,
  defaultRuntimeState,
  detectMongoUri,
  ensureRuntimeDir,
  isPortBusy,
  writeRuntimeState,
} from './lib';

export type PreflightResult = Readonly<{
  mongoUri: string;
  busyPorts: number[];
}>;

const REQUIRED_COMMANDS = ['bun', 'docker', 'mongosh'] as const;
const REQUIRED_PORTS = [3000, 4222, 8222] as const;

export const runPreflight = async (): Promise<PreflightResult> => {
  for (const command of REQUIRED_COMMANDS) {
    if (!checkCommandExists(command)) {
      throw new Error(`Missing required command: ${command}`);
    }
  }

  const busyPorts: number[] = [];
  for (const port of REQUIRED_PORTS) {
    if (await isPortBusy(port)) {
      busyPorts.push(port);
    }
  }

  const mongoUri = detectMongoUri();

  ensureRuntimeDir();
  const runtime = defaultRuntimeState(mongoUri);
  writeRuntimeState(runtime);

  return { mongoUri, busyPorts };
};

if (import.meta.main) {
  try {
    const result = await runPreflight();
    console.log('[e2e:preflight] ok');
    console.log(`[e2e:preflight] mongo=${result.mongoUri}`);
    if (result.busyPorts.length > 0) {
      console.log(`[e2e:preflight] busy_ports=${result.busyPorts.join(',')}`);
    } else {
      console.log('[e2e:preflight] busy_ports=none');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[e2e:preflight] failed: ${message}`);
    process.exit(1);
  }
}
