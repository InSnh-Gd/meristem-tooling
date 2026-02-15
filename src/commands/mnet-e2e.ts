import { runMnetE2EMatrix } from '../tests/mnet-e2e/matrix';

const parseArgValue = (flag: string, args: string[]): string | undefined => {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
};

export const runMnetE2ECommand = async (argv: readonly string[] = []): Promise<void> => {
  const args = [...argv];
  if (args.includes('--help')) {
    console.log('Usage: tooling test mnet-e2e [--out <json-path>] [--write-doc <md-path>]');
    return;
  }

  const outPath = parseArgValue('--out', args);
  const writeDocPath = parseArgValue('--write-doc', args);

  const report = await runMnetE2EMatrix({
    outPath,
    writeDocPath,
  });

  console.log(JSON.stringify(report, null, 2));
  if (report.totals.passRate < 95) {
    throw new Error(`mnet e2e pass rate below threshold: ${report.totals.passRate.toFixed(2)}%`);
  }
};

if (import.meta.main) {
  runMnetE2ECommand(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[tooling:test:mnet-e2e] failed: ${message}`);
    process.exit(1);
  });
}
