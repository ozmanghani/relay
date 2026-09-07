import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The benchmark report, read from the repository at build time.
 *
 * The file is written by `pnpm benchmark`, which measures against real
 * databases — this module only renders what that run recorded. Nothing here
 * invents, rounds or interpolates a number, which is the whole point of
 * keeping the source of truth in the repo rather than in the page.
 */
export interface BenchResult {
  scenario: string;
  rows: number;
  ms: number;
  rowsPerSec: number;
  detail?: Record<string, string | number>;
}

export interface BenchSuite {
  id: string;
  name: string;
  description: string;
  results: BenchResult[];
}

export interface BenchReport {
  generatedAt: string;
  /** the settings that produced these figures */
  configuration?: Record<string, string>;
  disclaimer: string;
  environment: Record<string, string>;
  suites: BenchSuite[];
}

/** repo root is one level above the website package */
const RESULTS = resolve(process.cwd(), '..', 'benchmarks', 'results.json');

export function loadBenchmarks(): BenchReport | null {
  try {
    return JSON.parse(readFileSync(RESULTS, 'utf8')) as BenchReport;
  } catch {
    // a checkout without a recorded run still builds; the page says so
    return null;
  }
}

/** "1000000" -> "1,000,000" */
export const formatNumber = (n: number): string => n.toLocaleString('en-US');

/** milliseconds as something a person reads: 189ms, 1.4s, 2m 34s */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}
