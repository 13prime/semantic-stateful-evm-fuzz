import { z } from "zod";

export const benchmarkCaseSchema = z.object({
  id: z.string().min(1),
  manifestPath: z.string().min(1),
  description: z.string().min(1).optional()
});

export const ablationModeSchema = z.enum([
  "full",
  "no-llm",
  "no-corpus",
  "manifest-only-invariants",
  "no-minimization"
]);

export const benchmarkSuiteSchema = z.object({
  id: z.string().min(1),
  cases: z.array(benchmarkCaseSchema).min(1)
});

export const benchmarkMetricsSchema = z.object({
  manifestId: z.string().min(1),
  mode: ablationModeSchema,
  scenarioCount: z.number().int().nonnegative(),
  advisoryScenarioCount: z.number().int().nonnegative(),
  advisoryLinkCount: z.number().int().nonnegative(),
  invariantBrokenCount: z.number().int().nonnegative(),
  oracleHitCount: z.number().int().nonnegative(),
  revertCount: z.number().int().nonnegative(),
  minimizedCount: z.number().int().nonnegative(),
  topStatus: z.enum(["ok", "revert", "oracle-hit", "invariant-broken"]),
  firstInterestingScenarioId: z.string().nullable()
});

export const benchmarkSummarySchema = z.object({
  suiteId: z.string().min(1),
  mode: ablationModeSchema,
  caseCount: z.number().int().positive(),
  metrics: z.array(benchmarkMetricsSchema),
  totals: z.object({
    scenarioCount: z.number().int().nonnegative(),
    advisoryScenarioCount: z.number().int().nonnegative(),
    advisoryLinkCount: z.number().int().nonnegative(),
    invariantBrokenCount: z.number().int().nonnegative(),
    oracleHitCount: z.number().int().nonnegative(),
    revertCount: z.number().int().nonnegative(),
    minimizedCount: z.number().int().nonnegative()
  })
});

export const benchmarkDeltaSchema = z.object({
  manifestId: z.string().min(1),
  againstMode: ablationModeSchema,
  relativeTo: ablationModeSchema,
  deltaScenarioCount: z.number().int(),
  deltaAdvisoryScenarioCount: z.number().int(),
  deltaAdvisoryLinkCount: z.number().int(),
  deltaInvariantBrokenCount: z.number().int(),
  deltaOracleHitCount: z.number().int(),
  deltaRevertCount: z.number().int(),
  deltaMinimizedCount: z.number().int()
});

export const comparisonReportSchema = z.object({
  suiteId: z.string().min(1),
  baselineMode: ablationModeSchema,
  comparisons: z.array(benchmarkSummarySchema),
  deltas: z.array(benchmarkDeltaSchema)
});

export type BenchmarkCase = z.infer<typeof benchmarkCaseSchema>;
export type AblationMode = z.infer<typeof ablationModeSchema>;
export type BenchmarkSuite = z.infer<typeof benchmarkSuiteSchema>;
export type BenchmarkMetrics = z.infer<typeof benchmarkMetricsSchema>;
export type BenchmarkSummary = z.infer<typeof benchmarkSummarySchema>;
export type BenchmarkDelta = z.infer<typeof benchmarkDeltaSchema>;
export type ComparisonReport = z.infer<typeof comparisonReportSchema>;
