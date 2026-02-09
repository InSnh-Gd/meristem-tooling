export {};

declare global {
  type BunStdioMode = 'pipe' | 'inherit' | 'ignore';

  type BunSpawnSyncOptions = {
    cmd: readonly string[];
    cwd?: string;
    stdout?: BunStdioMode;
    stderr?: BunStdioMode;
    env?: Record<string, string | undefined>;
  };

  type BunSpawnSyncResult = {
    exitCode: number;
    stdout: Uint8Array | null;
    stderr: Uint8Array | null;
  };

  type BunFileHandle = {
    json(): Promise<unknown>;
    text(): Promise<string>;
    exists(): Promise<boolean>;
  };

  type BunGlobal = {
    version: string;
    revision?: string;
    which?: (command: string) => string | null;
    file(path: string): BunFileHandle;
    write(path: string, data: string): Promise<number>;
    write(path: string, data: Uint8Array): Promise<number>;
    sleep(ms: number): Promise<void>;
    spawnSync(options: BunSpawnSyncOptions): BunSpawnSyncResult;
  };

  const Bun: BunGlobal;
}
