import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

type VerificationFailure = Readonly<{
  category: 'topic' | 'error-code' | 'ttl' | 'size-limit' | 'contract-version';
  message: string;
}>;

const readUtf8 = async (path: string): Promise<string> => {
  return readFile(path, 'utf8');
};

const parseIntegerConstant = (source: string, constantName: string): number | null => {
  const match = source.match(new RegExp(`const\\s+${constantName}\\s*=\\s*([^;]+);`));
  if (!match || typeof match[1] !== 'string') {
    return null;
  }

  const normalized = match[1].replace(/_/g, '').replace(/\s+/g, '');
  if (/^\d+$/.test(normalized)) {
    return Number(normalized);
  }

  const multiplySegments = normalized.split('*');
  if (multiplySegments.length > 1 && multiplySegments.every((segment: string) => /^\d+$/.test(segment))) {
    return multiplySegments.reduce((acc: number, segment: string) => acc * Number(segment), 1);
  }

  return null;
};

const parseStringConstant = (source: string, constantName: string): string | null => {
  const match = source.match(new RegExp(`const\\s+${constantName}\\s*=\\s*['"]([^'"]+)['"];`));
  return match?.[1] ?? null;
};

const assertIncludes = (
  failures: VerificationFailure[],
  input: {
    category: VerificationFailure['category'];
    haystack: string;
    needle: string;
    message: string;
  },
): void => {
  if (!input.haystack.includes(input.needle)) {
    failures.push(
      Object.freeze({
        category: input.category,
        message: input.message,
      }),
    );
  }
};

const verify = async (): Promise<readonly VerificationFailure[]> => {
  const workspaceRoot = resolve(process.env.MERISTEM_WORKSPACE_ROOT ?? resolve(import.meta.dir, '../..'));
  const failures: VerificationFailure[] = [];

  const [
    eventBusSpec,
    apiSpec,
    coreBootstrap,
    heartbeatService,
    natsTransport,
    sharedApiTypes,
  ] = await Promise.all([
    readUtf8(resolve(workspaceRoot, 'docs/standards/EVENT_BUS_SPEC.md')),
    readUtf8(resolve(workspaceRoot, 'docs/standards/API_SDK_SPEC.md')),
    readUtf8(resolve(workspaceRoot, 'meristem-core/src/index.ts')),
    readUtf8(resolve(workspaceRoot, 'meristem-core/src/services/heartbeat.ts')),
    readUtf8(resolve(workspaceRoot, 'meristem-core/src/utils/nats-transport.ts')),
    readUtf8(resolve(workspaceRoot, 'meristem-shared/src/types/api.ts')),
  ]);

  /**
   * 逻辑块：contract version 一致性校验。
   * - 目标：shared 类型常量与 API 文档中的 Header 示例保持同值。
   * - 原因：版本漂移会直接导致 join 握手失败。
   * - 降级：提取失败或文档缺失时直接报错并阻断测试入口。
   */
  const wireContractVersion = parseStringConstant(sharedApiTypes, 'WIRE_CONTRACT_VERSION');
  if (!wireContractVersion) {
    failures.push(
      Object.freeze({
        category: 'contract-version',
        message: 'failed to parse WIRE_CONTRACT_VERSION from meristem-shared/src/types/api.ts',
      }),
    );
  } else {
    assertIncludes(failures, {
      category: 'contract-version',
      haystack: apiSpec,
      needle: wireContractVersion,
      message: `API_SDK_SPEC.md missing wire contract version '${wireContractVersion}'`,
    });
  }

  /**
   * 逻辑块：size-limit 一致性校验。
   * - 目标：代码里的控制面 payload 预算与 EVENT_BUS 文档保持同值。
   * - 原因：链路预算不一致会导致分片策略失效或误判。
   * - 降级：常量无法解析时视为失败，避免静默通过。
   */
  const payloadBudgetBytes = parseIntegerConstant(natsTransport, 'DEFAULT_MAX_PAYLOAD_BYTES');
  if (!payloadBudgetBytes) {
    failures.push(
      Object.freeze({
        category: 'size-limit',
        message: 'failed to parse DEFAULT_MAX_PAYLOAD_BYTES from meristem-core/src/utils/nats-transport.ts',
      }),
    );
  } else {
    const payloadBudgetText = payloadBudgetBytes % 1024 === 0 ? `${payloadBudgetBytes / 1024}KiB` : `${payloadBudgetBytes}B`;
    assertIncludes(failures, {
      category: 'size-limit',
      haystack: eventBusSpec,
      needle: payloadBudgetText,
      message: `EVENT_BUS_SPEC.md missing payload budget '${payloadBudgetText}'`,
    });
  }

  const heartbeatIntervalMs = parseIntegerConstant(heartbeatService, 'HEARTBEAT_INTERVAL_MS');
  const offlineThresholdMs = parseIntegerConstant(heartbeatService, 'OFFLINE_THRESHOLD_MS');
  if (!heartbeatIntervalMs || !offlineThresholdMs) {
    failures.push(
      Object.freeze({
        category: 'ttl',
        message: 'failed to parse heartbeat timing constants from meristem-core/src/services/heartbeat.ts',
      }),
    );
  } else {
    const heartbeatSeconds = Math.floor(heartbeatIntervalMs / 1000);
    const offlineSeconds = Math.floor(offlineThresholdMs / 1000);
    assertIncludes(failures, {
      category: 'ttl',
      haystack: eventBusSpec,
      needle: `Heartbeat Interval | ${heartbeatSeconds}s`,
      message: `EVENT_BUS_SPEC.md missing Heartbeat Interval '${heartbeatSeconds}s'`,
    });
    assertIncludes(failures, {
      category: 'ttl',
      haystack: eventBusSpec,
      needle: `Offline Threshold | ${offlineSeconds}s`,
      message: `EVENT_BUS_SPEC.md missing Offline Threshold '${offlineSeconds}s'`,
    });
  }

  assertIncludes(failures, {
    category: 'topic',
    haystack: coreBootstrap,
    needle: 'meristem.v1.hb.>',
    message: "meristem-core/src/index.ts missing heartbeat topic 'meristem.v1.hb.>'",
  });
  assertIncludes(failures, {
    category: 'topic',
    haystack: eventBusSpec,
    needle: 'meristem.v1.hb.[id]',
    message: "EVENT_BUS_SPEC.md missing heartbeat topic template 'meristem.v1.hb.[id]'",
  });

  for (const errorCode of [
    'AUDIT_BACKPRESSURE',
    'WIRE_CONTRACT_VERSION_MISMATCH',
    'NETWORK_LEASE_CONFLICT',
    'RESULT_SUBMISSION_FAILED',
  ]) {
    assertIncludes(failures, {
      category: 'error-code',
      haystack: apiSpec,
      needle: `\`${errorCode}\``,
      message: `API_SDK_SPEC.md missing error code '${errorCode}'`,
    });
  }

  return failures;
};

const main = async (): Promise<void> => {
  const failures = await verify();
  if (failures.length === 0) {
    console.log('[verify-standards-sync] PASS');
    return;
  }

  console.error(`[verify-standards-sync] FAIL (${failures.length})`);
  for (const [index, failure] of failures.entries()) {
    console.error(`${index + 1}. [${failure.category}] ${failure.message}`);
  }
  process.exit(1);
};

await main();
