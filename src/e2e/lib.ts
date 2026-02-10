#!/usr/bin/env bun

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, openSync, closeSync, rmSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { resolveTestArtifactPath, resolveWorkspaceRoot } from '../utils/test-artifacts';

export type CommandResult = Readonly<{
  code: number;
  stdout: string;
  stderr: string;
}>;

export type RuntimeState = Readonly<{
  mongoUri: string;
  natsUrl: string;
  coreUrl: string;
  traceId: string;
  startedAt: string;
  logs: Readonly<{
    core: string;
    client: string;
  }>;
  pids: Readonly<{
    core?: number;
    client?: number;
  }>;
}>;

const NATS_URL_DEFAULT = 'nats://localhost:4222';
const CORE_URL_DEFAULT = 'http://localhost:3000';

/**
 * 逻辑块：tooling 仓独立后，工作区根目录不能再依赖脚本相对路径。
 * 优先读取 `MERISTEM_WORKSPACE_ROOT`，未提供时回退当前执行目录，
 * 这样无论是本地 `bun run` 还是未来 JSR 包调用，都能稳定定位 core/client/shared。
 */
export const ROOT_DIR = resolveWorkspaceRoot();
export const CORE_DIR = path.join(ROOT_DIR, 'meristem-core');
export const CLIENT_DIR = path.join(ROOT_DIR, 'meristem-client');
export const SHARED_DIR = path.join(ROOT_DIR, 'meristem-shared');
export const RUNTIME_DIR = resolveTestArtifactPath('meristem-test-e2e-runtime');
export const RUNTIME_FILE = path.join(RUNTIME_DIR, 'runtime.json');

const composeChoices: ReadonlyArray<ReadonlyArray<string>> = [
  ['docker', 'compose'],
  ['docker-compose'],
];

export const ensureRuntimeDir = (): void => {
  mkdirSync(RUNTIME_DIR, { recursive: true });
};

export const runCommand = (
  command: string,
  args: readonly string[],
  options: Readonly<{ cwd?: string; env?: Record<string, string | undefined> }> = {}
): CommandResult => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    encoding: 'utf-8',
  });

  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};

export const assertCommand = (
  command: string,
  args: readonly string[],
  options: Readonly<{ cwd?: string; env?: Record<string, string | undefined>; label: string }>
): CommandResult => {
  const result = runCommand(command, args, options);
  if (result.code !== 0) {
    throw new Error(`[${options.label}] failed with code ${result.code}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
};

export const resolveComposeCommand = (): readonly string[] => {
  for (const candidate of composeChoices) {
    const [cmd, ...rest] = candidate;
    const probe = runCommand(cmd, [...rest, 'version']);
    if (probe.code === 0) {
      return candidate;
    }
  }
  throw new Error('docker compose is not available');
};

export const runCompose = (args: readonly string[], label: string): CommandResult => {
  const compose = resolveComposeCommand();
  const [cmd, ...prefix] = compose;
  return assertCommand(cmd, [...prefix, ...args], { cwd: ROOT_DIR, label });
};

export const waitFor = async (
  predicate: () => Promise<boolean> | boolean,
  timeoutMs: number,
  intervalMs: number,
  label: string,
): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await predicate();
    if (ok) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timeout waiting for ${label}`);
};

export const isPortBusy = async (port: number): Promise<boolean> => {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(800);

    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });

    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });

    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });

    socket.connect(port, '127.0.0.1');
  });
};

export const checkCommandExists = (name: string): boolean => {
  return runCommand('bash', ['-lc', `command -v ${name}`]).code === 0;
};

const parseMongoProbeResult = (output: string): boolean => {
  const normalized = output.trim();
  return normalized.endsWith('1') || normalized === '1';
};

export const detectMongoUri = (): string => {
  const candidates = [
    process.env.MERISTEM_DATABASE_MONGO_URI,
    'mongodb://localhost:27017/meristem_e2e',
    'mongodb://127.0.0.1:27017/meristem_e2e',
  ].filter((uri): uri is string => Boolean(uri && uri.trim().length > 0));

  for (const uri of candidates) {
    const probe = runCommand('mongosh', [uri, '--quiet', '--eval', 'db.runCommand({ ping: 1 }).ok']);
    if (probe.code === 0 && parseMongoProbeResult(probe.stdout)) {
      return uri;
    }
  }

  throw new Error('No reachable MongoDB instance found from candidate URIs');
};

export const createTraceId = (): string => {
  return `e2e-${Date.now()}`;
};

export const defaultRuntimeState = (mongoUri: string): RuntimeState => {
  return {
    mongoUri,
    natsUrl: process.env.MERISTEM_NATS_URL ?? NATS_URL_DEFAULT,
    coreUrl: process.env.MERISTEM_CORE_URL ?? CORE_URL_DEFAULT,
    traceId: process.env.E2E_TRACE_ID ?? createTraceId(),
    startedAt: new Date().toISOString(),
    logs: {
      core: path.join(RUNTIME_DIR, 'core.log'),
      client: path.join(RUNTIME_DIR, 'client.log'),
    },
    pids: {},
  };
};

export const writeRuntimeState = (state: RuntimeState): void => {
  ensureRuntimeDir();
  writeFileSync(RUNTIME_FILE, JSON.stringify(state, null, 2), 'utf-8');
};

export const readRuntimeState = (): RuntimeState => {
  if (!existsSync(RUNTIME_FILE)) {
    throw new Error(`runtime state not found: ${RUNTIME_FILE}`);
  }
  const raw = readFileSync(RUNTIME_FILE, 'utf-8');
  const parsed = JSON.parse(raw) as RuntimeState;
  return parsed;
};

export const startBackgroundProcess = (
  command: string,
  args: readonly string[],
  options: Readonly<{ cwd: string; env: Record<string, string | undefined>; logFile: string }>
): number => {
  ensureRuntimeDir();
  const fd = openSync(options.logFile, 'a');
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  closeSync(fd);
  child.unref();

  if (typeof child.pid !== 'number') {
    throw new Error(`Failed to start process: ${command}`);
  }

  return child.pid;
};

export const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const stopProcess = (pid: number): void => {
  if (!processAlive(pid)) {
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
};

export const resetClientCredentials = (): void => {
  const credentialsDir = path.join(CLIENT_DIR, '.meristem');
  if (existsSync(credentialsDir)) {
    rmSync(credentialsDir, { recursive: true, force: true });
  }
  mkdirSync(credentialsDir, { recursive: true });
};

export const readLogText = (logFile: string): string => {
  if (!existsSync(logFile)) {
    return '';
  }
  return readFileSync(logFile, 'utf-8');
};

export const fetchJson = async (url: string): Promise<unknown> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Fetch failed ${url}: ${response.status}`);
  }
  return (await response.json()) as unknown;
};

export const fetchText = async (url: string): Promise<string> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Fetch failed ${url}: ${response.status}`);
  }
  return response.text();
};
