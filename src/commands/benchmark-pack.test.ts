import { describe, expect, test } from 'bun:test';
import {
  decodeComparisonSource,
  evaluateBenchmarkGate,
  type BenchmarkGatePolicy,
} from './benchmark-pack.ts';

const buildProfile = () => ({
  generatedAt: '2026-02-10T00:00:00.000Z',
  runtime: {
    bunVersion: '1.3.8',
    bunRevision: null,
    platform: 'linux',
    arch: 'x64',
  },
  options: {
    warmupRounds: 5,
    rounds: 12,
    intervalMs: 1000,
  },
  metrics: [
    {
      name: 'json-stringify-parse',
      rounds: 12,
      medianOpsPerSecond: 400000,
      trimmedMeanOpsPerSecond: 390000,
      minOpsPerSecond: 320000,
      maxOpsPerSecond: 460000,
      coefficientOfVariation: 0.2,
    },
  ],
});

const buildLegacyBaseline = () => ({
  generatedAt: '2026-02-10T00:00:00.000Z',
  runtime: {
    bunVersion: '1.3.8',
    platform: 'linux',
    arch: 'x64',
  },
  samples: [
    {
      name: 'json-stringify-parse',
      iterations: 20000,
      durationMs: 50,
      opsPerSecond: 400000,
    },
  ],
});

const basePolicy: BenchmarkGatePolicy = {
  maxCv: 0.35,
  maxMedianRegressionPct: 20,
  requireComparison: true,
};

describe('benchmark pack comparison source', () => {
  test('accepts baseline profile as comparison source', () => {
    const source = decodeComparisonSource(buildProfile(), '/tmp/baseline-profile.json');
    expect(source.mode).toBe('profile');
    expect(source.sourcePath).toBe('/tmp/baseline-profile.json');
    expect(source.values.get('json-stringify-parse')?.medianOpsPerSecond).toBe(400000);
  });

  test('rejects legacy single-sample baseline report', () => {
    let capturedError: unknown = null;
    try {
      decodeComparisonSource(buildLegacyBaseline(), '/tmp/legacy-baseline.json');
    } catch (error) {
      capturedError = error;
    }

    expect(capturedError instanceof Error).toBe(true);
    if (capturedError instanceof Error) {
      expect(capturedError.message.includes('legacy single-sample baseline is not supported')).toBe(
        true,
      );
    }
  });
});

describe('benchmark gate evaluation', () => {
  test('passes when cv and median regression are within threshold', () => {
    const result = evaluateBenchmarkGate(
      [
        { name: 'json-stringify-parse', coefficientOfVariation: 0.2, medianDeltaPct: -5 },
        { name: 'uint8array-copy', coefficientOfVariation: 0.1, medianDeltaPct: 8 },
      ],
      true,
      basePolicy,
    );

    expect(result.passed).toBe(true);
    expect(result.violations.length).toBe(0);
  });

  test('fails when coefficient of variation exceeds threshold', () => {
    const result = evaluateBenchmarkGate(
      [{ name: 'json-stringify-parse', coefficientOfVariation: 0.5, medianDeltaPct: -2 }],
      true,
      basePolicy,
    );

    expect(result.passed).toBe(false);
    expect(result.violations.some((violation) => violation.rule === 'cv')).toBe(true);
  });

  test('fails when compared mode is required but comparison source is missing', () => {
    const result = evaluateBenchmarkGate(
      [{ name: 'json-stringify-parse', coefficientOfVariation: 0.2, medianDeltaPct: null }],
      false,
      basePolicy,
    );

    expect(result.passed).toBe(false);
    expect(result.violations.some((violation) => violation.rule === 'missing-comparison')).toBe(true);
  });

  test('fails when median regression exceeds threshold', () => {
    const result = evaluateBenchmarkGate(
      [{ name: 'json-stringify-parse', coefficientOfVariation: 0.2, medianDeltaPct: -25 }],
      true,
      basePolicy,
    );

    expect(result.passed).toBe(false);
    expect(result.violations.some((violation) => violation.rule === 'median-regression')).toBe(true);
  });
});
