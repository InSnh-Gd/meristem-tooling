import { runMnetMeshFromCli } from '../tests/mnet-e2e/mesh';

export const runMnetMeshCommand = async (argv: readonly string[] = []): Promise<void> => {
  await runMnetMeshFromCli(argv);
};

if (import.meta.main) {
  runMnetMeshCommand(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[tooling:test:mnet-mesh] failed: ${message}`);
    process.exit(1);
  });
}
