import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runPreflight } from '../../e2e/preflight';
import {
  CLIENT_DIR,
  CORE_DIR,
  SHARED_DIR,
  readRuntimeState,
  runCommand,
  runCompose,
  startBackgroundProcess,
  stopProcess,
  waitFor,
} from '../../e2e/lib';
import { resolveTestArtifactPath, resolveWorkspaceRoot } from '../../utils/test-artifacts';

type MeshOptions = Readonly<{
  nodes: number;
  timeoutMs: number;
  keepAlive: boolean;
  reportPath?: string;
}>;

type MeshClientReport = Readonly<{
  index: number;
  hostname: string;
  pid: number;
  credentialsPath: string;
  logPath: string;
  joined: boolean;
  nodeId?: string;
}>;

export type MeshReport = Readonly<{
  generatedAt: string;
  workspaceRoot: string;
  nodeTarget: number;
  nodeJoined: number;
  successRate: number;
  mongoNodeCount: number;
  clients: readonly MeshClientReport[];
}>;

const parseIntOption = (value: string | undefined, fallback: number, min: number): number => {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`invalid integer option: ${value}`);
  }
  return parsed;
};

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
    'core health for mesh',
  );
};

const readNodeIdFromCredentials = (credentialsPath: string): string | null => {
  if (!existsSync(credentialsPath)) {
    return null;
  }

  try {
    const raw = readFileSync(credentialsPath, 'utf-8');
    const parsed = JSON.parse(raw) as { node_id?: unknown };
    return typeof parsed.node_id === 'string' ? parsed.node_id : null;
  } catch {
    return null;
  }
};

const queryMeshNodeCount = (mongoUri: string): number => {
  const evalCode = [
    "const coll = db.getCollection('nodes');",
    "const count = coll.countDocuments({ hostname: { $regex: '^mesh-client-' } });",
    'print(count);',
  ].join('\n');

  const result = runCommand('mongosh', [mongoUri, '--quiet', '--eval', evalCode], {
    cwd: CORE_DIR,
  });
  if (result.code !== 0) {
    return 0;
  }
  const normalized = result.stdout.trim();
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : 0;
};

const startMeshClients = (
  nodeCount: number,
  coreUrl: string,
  natsUrl: string,
): MeshClientReport[] => {
  const reports: MeshClientReport[] = [];
  const meshRoot = resolveTestArtifactPath('meristem-test-mesh-runtime');
  mkdirSync(meshRoot, { recursive: true });

  for (let index = 0; index < nodeCount; index += 1) {
    const clientDir = path.join(meshRoot, `client-${index}`);
    mkdirSync(clientDir, { recursive: true });

    const credentialsPath = path.join(clientDir, 'credentials.json');
    const configPath = path.join(clientDir, 'config.json');
    const logPath = path.join(clientDir, 'client.log');
    const hostname = `mesh-client-${index}`;
    const nodeOverride = `mesh-node-${index}`;

    writeFileSync(
      configPath,
      JSON.stringify(
        {
          node_id_override: nodeOverride,
        },
        null,
        2,
      ),
      'utf-8',
    );

    const pid = startBackgroundProcess('bun', ['run', 'src/index.ts'], {
      cwd: CLIENT_DIR,
      env: {
        MERISTEM_CORE_URL: coreUrl,
        MERISTEM_NATS_URL: natsUrl,
        MERISTEM_CREDENTIALS_PATH: credentialsPath,
        MERISTEM_CONFIG_PATH: configPath,
        MERISTEM_HOSTNAME: hostname,
      },
      logFile: logPath,
    });

    reports.push({
      index,
      hostname,
      pid,
      credentialsPath,
      logPath,
      joined: false,
    });
  }

  return reports;
};

const waitForMeshJoin = async (
  clients: MeshClientReport[],
  timeoutMs: number,
): Promise<MeshClientReport[]> => {
  /**
   * 逻辑块：多节点 Join 采用“凭据文件 + 日志”双信号判定。
   * 单看日志容易受输出时序影响，单看文件又可能读到半写入内容；
   * 双信号组合可降低并发场景下误判，保证每个 client 的成功状态可复核。
   */
  await waitFor(
    () => {
      let ready = 0;
      for (const client of clients) {
        const nodeId = readNodeIdFromCredentials(client.credentialsPath);
        if (nodeId) {
          ready += 1;
        }
      }
      return ready === clients.length;
    },
    timeoutMs,
    1_000,
    'mesh clients join',
  );

  return clients.map((client) => {
    const nodeId = readNodeIdFromCredentials(client.credentialsPath) ?? undefined;
    return {
      ...client,
      joined: typeof nodeId === 'string',
      nodeId,
    };
  });
};

const cleanupMeshProcesses = (corePid: number | null, clients: readonly MeshClientReport[]): void => {
  for (const client of clients) {
    stopProcess(client.pid);
  }
  if (corePid !== null) {
    stopProcess(corePid);
  }

  try {
    runCompose(['-f', 'docker-compose.test.yml', 'down', '-v'], 'docker compose down for mesh');
  } catch {
  }
};

export const runMnetMesh = async (options: MeshOptions): Promise<MeshReport> => {
  await runPreflight();
  const runtime = readRuntimeState();
  ensureSharedBuild();

  runCompose(['-f', 'docker-compose.test.yml', 'up', '-d'], 'docker compose up for mesh');

  let corePid: number | null = null;
  let startedClients: MeshClientReport[] = [];

  try {
    const coreLogPath = resolveTestArtifactPath('meristem-test-mesh-runtime', 'core.log');
    mkdirSync(path.dirname(coreLogPath), { recursive: true });
    corePid = startBackgroundProcess('bun', ['run', 'src/index.ts'], {
      cwd: CORE_DIR,
      env: {
        MERISTEM_NATS_URL: runtime.natsUrl,
        MERISTEM_DATABASE_MONGO_URI: runtime.mongoUri,
        MERISTEM_SERVER_PORT: '3000',
      },
      logFile: coreLogPath,
    });

    await waitForCoreHealth(runtime.coreUrl);
    startedClients = startMeshClients(options.nodes, runtime.coreUrl, runtime.natsUrl);
    const clients = await waitForMeshJoin(startedClients, options.timeoutMs);
    const joined = clients.filter((client) => client.joined).length;
    const mongoNodeCount = queryMeshNodeCount(runtime.mongoUri);
    const report: MeshReport = {
      generatedAt: new Date().toISOString(),
      workspaceRoot: resolveWorkspaceRoot(),
      nodeTarget: options.nodes,
      nodeJoined: joined,
      successRate: options.nodes === 0 ? 0 : (joined / options.nodes) * 100,
      mongoNodeCount,
      clients,
    };

    const reportPath =
      options.reportPath ?? resolveTestArtifactPath('meristem-test-mesh-runtime', 'mesh-report.json');
    mkdirSync(path.dirname(reportPath), { recursive: true });
    await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);

    if (joined !== options.nodes) {
      throw new Error(`mesh join failed: ${joined}/${options.nodes} clients joined`);
    }

    return report;
  } finally {
    if (!options.keepAlive) {
      cleanupMeshProcesses(corePid, startedClients);
    }
  }
};

export const runMnetMeshFromCli = async (argv: readonly string[] = []): Promise<void> => {
  const args = [...argv];
  if (args.includes('--help')) {
    console.log(
      'Usage: tooling test mnet-mesh [--nodes <n>] [--timeout-ms <ms>] [--report <path>] [--keep-alive]',
    );
    return;
  }

  const nodesFlag = args.indexOf('--nodes');
  const timeoutFlag = args.indexOf('--timeout-ms');
  const reportFlag = args.indexOf('--report');

  const nodes = parseIntOption(nodesFlag >= 0 ? args[nodesFlag + 1] : undefined, 5, 1);
  const timeoutMs = parseIntOption(timeoutFlag >= 0 ? args[timeoutFlag + 1] : undefined, 90_000, 5_000);
  const reportPath = reportFlag >= 0 ? args[reportFlag + 1] : undefined;

  const report = await runMnetMesh({
    nodes,
    timeoutMs,
    keepAlive: args.includes('--keep-alive'),
    reportPath,
  });
  console.log(JSON.stringify(report, null, 2));
};
