#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import {
  CORE_DIR,
  fetchJson,
  processAlive,
  readLogText,
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
type StreamzState = Readonly<{ messages?: number }>;
type StreamzEntry = Readonly<{
  name?: string;
  config?: Readonly<{ name?: string }>;
  state?: StreamzState;
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

const readMessagesFromJsz = (jsz: JszResponse): number | null => {
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

  return null;
};

const readMessagesFromStreamzEntry = (entry: StreamzEntry | null): number | null => {
  if (!entry) {
    return null;
  }
  const name = entry.name ?? entry.config?.name;
  if (name !== 'MERISTEM_LOGS') {
    return null;
  }
  if (typeof entry.state?.messages === 'number') {
    return entry.state.messages;
  }
  return null;
};

const readMessagesFromStreamz = (value: unknown): number | null => {
  if (!isRecord(value)) {
    return null;
  }

  const direct = readMessagesFromStreamzEntry(value as StreamzEntry);
  if (direct !== null) {
    return direct;
  }

  const streamField = isRecord(value.stream) ? (value.stream as StreamzEntry) : null;
  const streamValue = readMessagesFromStreamzEntry(streamField);
  if (streamValue !== null) {
    return streamValue;
  }

  if (!Array.isArray(value.streams)) {
    return null;
  }
  for (const stream of value.streams as readonly unknown[]) {
    if (!isRecord(stream)) {
      continue;
    }
    const streamMessages = readMessagesFromStreamzEntry(stream as StreamzEntry);
    if (streamMessages !== null) {
      return streamMessages;
    }
  }
  return null;
};

const probeJetstreamMessages = async (): Promise<number | null> => {
  try {
    const rawJsz = await fetchJson('http://localhost:8222/jsz?streams=true');
    const fromJsz = readMessagesFromJsz(toJszResponse(rawJsz));
    if (fromJsz !== null) {
      return fromJsz;
    }
  } catch {
    // fallback to streamz
  }

  try {
    const rawStreamz = await fetchJson('http://localhost:8222/streamz?name=MERISTEM_LOGS');
    return readMessagesFromStreamz(rawStreamz);
  } catch {
    return null;
  }
};

const waitForJetstreamMessages = async (): Promise<number> => {
  const timeoutMs = 20_000;
  const intervalMs = 500;
  const deadline = Date.now() + timeoutMs;
  let lastObservedMessages: number | null = null;

  /**
   * 逻辑块：JetStream 观测采用“短轮询 + 超时”的最终一致性判定。
   * 启动阶段 stream 元数据与消息计数可能短暂不可见，立即断言会放大时序抖动。
   * 因此这里允许在窗口内等待 stream 出现并积累到正消息数，超时后再给出确定性失败信息。
   */
  while (Date.now() < deadline) {
    const messages = await probeJetstreamMessages();
    if (messages !== null) {
      lastObservedMessages = messages;
      if (messages > 0) {
        return messages;
      }
    }
    await Bun.sleep(intervalMs);
  }

  if (lastObservedMessages !== null) {
    throw new Error(
      `JetStream MERISTEM_LOGS has no messages after waiting ${timeoutMs}ms (last=${lastObservedMessages})`,
    );
  }
  throw new Error(`MERISTEM_LOGS stream not found after waiting ${timeoutMs}ms`);
};

const shouldTreatJetstreamAsOptional = (coreLogFile: string): boolean => {
  const coreLog = readLogText(coreLogFile);
  return coreLog.includes('falling back to non-persistent mode');
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

  const jetstreamOptional = shouldTreatJetstreamAsOptional(state.logs.core);
  let messages: number | null = null;

  /**
   * 逻辑块：JetStream 校验遵循“可持久化优先、降级模式容忍”策略。
   * 当 Core 明确记录了 non-persistent 回退时，stream 不存在属于已知运行模式，不应阻断 E2E。
   * 在可持久化模式下，仍要求 MERISTEM_LOGS 可见且消息数大于 0，保证日志链路可观测。
   */
  try {
    messages = await waitForJetstreamMessages();
  } catch (error) {
    if (!jetstreamOptional) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[e2e:assert] skip jetstream strict check in non-persistent mode: ${message}`);
  }

  if (messages !== null && messages <= 0) {
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
