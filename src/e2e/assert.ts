#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import {
  CORE_DIR,
  fetchJson,
  processAlive,
  readRuntimeState,
  runCommand,
} from './lib';

type JszStreamState = Readonly<{ messages?: number }>;
type JszLegacyStream = Readonly<{ config?: Readonly<{ name?: string }>; state?: JszStreamState }>;
type JszAccountStream = Readonly<{ name?: string; state?: JszStreamState }>;
type JszAccountDetail = Readonly<{ stream_detail?: readonly JszAccountStream[] }>;
type JszResponse = Readonly<{
  streams?: readonly JszLegacyStream[];
  account_details?: readonly JszAccountDetail[];
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const toJszResponse = (value: unknown): JszResponse => {
  if (!isRecord(value)) {
    throw new Error('invalid jsz response type');
  }

  const streams = Array.isArray(value.streams) ? (value.streams as readonly JszLegacyStream[]) : undefined;
  const accountDetails = Array.isArray(value.account_details)
    ? (value.account_details as readonly JszAccountDetail[])
    : undefined;

  return {
    streams,
    account_details: accountDetails,
  };
};

const ensureCoreHealthy = async (coreUrl: string): Promise<void> => {
  const response = await fetch(`${coreUrl}/health`);
  if (!response.ok) {
    throw new Error(`core health failed: ${response.status}`);
  }
};

const sendJoinProbe = async (coreUrl: string, traceId: string): Promise<void> => {
  const hwid = createHash('sha256').update(`probe-${Date.now()}`).digest('hex');
  const payload = {
    hwid,
    hostname: 'e2e-probe',
    persona: 'AGENT',
  } as const;

  const response = await fetch(`${coreUrl}/api/v1/join`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Trace-Id': traceId,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`join probe failed: ${response.status} ${body}`);
  }
};

const getJetstreamMessages = async (): Promise<number> => {
  const raw = await fetchJson('http://localhost:8222/jsz?streams=true');
  const jsz = toJszResponse(raw);

  const legacyStreams = jsz.streams ?? [];
  const legacyTarget = legacyStreams.find((stream) => stream.config?.name === 'MERISTEM_LOGS');
  if (legacyTarget?.state?.messages !== undefined) {
    return legacyTarget.state.messages;
  }

  for (const detail of jsz.account_details ?? []) {
    for (const stream of detail.stream_detail ?? []) {
      if (stream.name === 'MERISTEM_LOGS') {
        return stream.state?.messages ?? 0;
      }
    }
  }

  throw new Error('MERISTEM_LOGS stream not found');
};

const verifyAuditChain = (mongoUri: string, startedAt: string): { count: number; valid: boolean; error?: string } => {
  const evalCode = `
import { MongoClient } from 'mongodb';
import { AUDIT_COLLECTION, calculateHash } from './src/services/audit.ts';

const uri = process.env.MERISTEM_DATABASE_MONGO_URI ?? 'mongodb://localhost:27017/meristem';
const inferDbNameFromUri = (input: string): string | undefined => {
  try {
    const parsed = new URL(input);
    const normalizedPath = parsed.pathname.replace(/^\\/+/, '');
    const name = normalizedPath.split('/')[0];
    return name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
};
const dbName = process.env.MERISTEM_DATABASE_MONGO_DB_NAME ?? inferDbNameFromUri(uri) ?? 'meristem';
const startedTs = Number(process.env.E2E_STARTED_TS ?? 0);
const client = new MongoClient(uri);
await client.connect();
const db = client.db(dbName);
const logs = await db.collection(AUDIT_COLLECTION).find({ ts: { $gte: startedTs } }).sort({ _sequence: 1 }).toArray();

let valid = true;
let error = undefined;
for (let i = 0; i < logs.length; i += 1) {
  const current = logs[i];
  const expectedHash = calculateHash(current);
  if (current._hash !== expectedHash) {
    valid = false;
    error = \`哈希验证失败：序列 \${current._sequence} 的哈希不匹配\`;
    break;
  }

  if (i > 0) {
    const previous = logs[i - 1];
    if (current._previous_hash !== previous._hash) {
      valid = false;
      error = \`哈希链断裂：序列 \${current._sequence} 的 _previous_hash 与前一条日志不匹配\`;
      break;
    }
  }
}

console.log(JSON.stringify({ count: logs.length, valid, error }));
await client.close();
`;

  const result = runCommand('bun', ['-e', evalCode], {
    cwd: CORE_DIR,
    env: {
      MERISTEM_DATABASE_MONGO_URI: mongoUri,
      E2E_STARTED_TS: `${Date.parse(startedAt)}`,
    },
  });

  if (result.code !== 0) {
    throw new Error(`audit verification command failed\n${result.stdout}\n${result.stderr}`);
  }

  const output = result.stdout.trim();
  const parsed = JSON.parse(output) as { count: number; valid: boolean; error?: string };
  return parsed;
};

export const assertE2E = async (): Promise<void> => {
  const state = readRuntimeState();

  if (!state.pids.core || !processAlive(state.pids.core)) {
    throw new Error('core process is not alive');
  }

  if (!state.pids.client || !processAlive(state.pids.client)) {
    throw new Error('client process is not alive');
  }

  await ensureCoreHealthy(state.coreUrl);
  await sendJoinProbe(state.coreUrl, state.traceId);

  const messages = await getJetstreamMessages();
  if (messages <= 0) {
    throw new Error('JetStream MERISTEM_LOGS has no messages');
  }

  const audit = verifyAuditChain(state.mongoUri, state.startedAt);
  if (!audit.valid) {
    throw new Error(`audit chain invalid: ${audit.error ?? 'unknown error'}`);
  }

  if (audit.count <= 0) {
    throw new Error('audit_logs has no documents');
  }
};

if (import.meta.main) {
  try {
    await assertE2E();
    console.log('[e2e:assert] ok');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[e2e:assert] failed: ${message}`);
    process.exit(1);
  }
}
