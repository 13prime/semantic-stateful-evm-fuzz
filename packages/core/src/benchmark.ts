import path from "node:path";

import { executeCampaign, resolveCampaignInputs } from "./campaign.js";
import {
  benchmarkSummarySchema,
  comparisonReportSchema,
  type AblationMode,
  type BenchmarkCase,
  type BenchmarkDelta,
  type BenchmarkMetrics,
  type BenchmarkSummary,
  type CampaignConfig,
  type CampaignResult,
  type ComparisonReport
} from "../../shared/src/index.js";
import { loadManifest } from "../../protocols/src/manifest-loader.js";

function summarizeCase(result: CampaignResult, mode: AblationMode): BenchmarkMetrics {
  const advisoryScenarioCount = result.scenarios.filter((scenario) => scenario.source === "llm").length;
  const invariantBrokenCount = result.results.filter((entry) => entry.status === "invariant-broken").length;
  const oracleHitCount = result.results.filter((entry) => entry.status === "oracle-hit").length;
  const revertCount = result.results.filter((entry) => entry.status === "revert").length;
  const firstInteresting = result.results.find((entry) => entry.status === "invariant-broken" || entry.status === "oracle-hit") ?? null;

  return {
    manifestId: result.manifestId,
    mode,
    scenarioCount: result.scenarioCount,
    advisoryScenarioCount,
    advisoryLinkCount: result.advisoryLinks.length,
    invariantBrokenCount,
    oracleHitCount,
    revertCount,
    minimizedCount: result.minimizations.length,
    topStatus: result.summary.topStatus,
    firstInterestingScenarioId: firstInteresting?.scenarioId ?? null
  };
}

export async function runBenchmarkSuite(
  suiteId: string,
  cases: BenchmarkCase[],
  configOverrides?: Partial<CampaignConfig>
): Promise<BenchmarkSummary> {
  const metrics: BenchmarkMetrics[] = [];
  const mode = configOverrides?.ablationMode ?? "full";

  for (const benchmarkCase of cases) {
    const manifest = await loadManifest(benchmarkCase.manifestPath);
    const config: CampaignConfig = {
      target: benchmarkCase.manifestPath,
      maxSequenceLength: configOverrides?.maxSequenceLength ?? 6,
      maxIterations: configOverrides?.maxIterations ?? 100,
      llmEnabled: configOverrides?.llmEnabled ?? true,
      ablationMode: mode,
      artifactDir: configOverrides?.artifactDir ?? path.resolve("artifacts", "benchmarks"),
      execution: {
        executor: configOverrides?.execution?.executor ?? manifest.chain
      }
    };

    const advisorySnapshot = await resolveCampaignInputs(manifest, config);
    const result = await executeCampaign(manifest, config);
    const normalized = {
      ...result,
      advisory: advisorySnapshot.advisory,
      advisoryLinks: advisorySnapshot.advisoryLinks
    };
    metrics.push(summarizeCase(normalized, mode));
  }

  const totals = metrics.reduce(
    (acc, entry) => ({
      scenarioCount: acc.scenarioCount + entry.scenarioCount,
      advisoryScenarioCount: acc.advisoryScenarioCount + entry.advisoryScenarioCount,
      advisoryLinkCount: acc.advisoryLinkCount + entry.advisoryLinkCount,
      invariantBrokenCount: acc.invariantBrokenCount + entry.invariantBrokenCount,
      oracleHitCount: acc.oracleHitCount + entry.oracleHitCount,
      revertCount: acc.revertCount + entry.revertCount,
      minimizedCount: acc.minimizedCount + entry.minimizedCount
    }),
    {
      scenarioCount: 0,
      advisoryScenarioCount: 0,
      advisoryLinkCount: 0,
      invariantBrokenCount: 0,
      oracleHitCount: 0,
      revertCount: 0,
      minimizedCount: 0
    }
  );

  return benchmarkSummarySchema.parse({
    suiteId,
    mode,
    caseCount: cases.length,
    metrics,
    totals
  });
}

function computeDeltas(baseline: BenchmarkSummary, comparison: BenchmarkSummary): BenchmarkDelta[] {
  return comparison.metrics.map((metric) => {
    const base = baseline.metrics.find((entry) => entry.manifestId === metric.manifestId);
    if (!base) {
      throw new Error(`Missing baseline metric for manifest ${metric.manifestId}`);
    }

    return {
      manifestId: metric.manifestId,
      againstMode: comparison.mode,
      relativeTo: baseline.mode,
      deltaScenarioCount: metric.scenarioCount - base.scenarioCount,
      deltaAdvisoryScenarioCount: metric.advisoryScenarioCount - base.advisoryScenarioCount,
      deltaAdvisoryLinkCount: metric.advisoryLinkCount - base.advisoryLinkCount,
      deltaInvariantBrokenCount: metric.invariantBrokenCount - base.invariantBrokenCount,
      deltaOracleHitCount: metric.oracleHitCount - base.oracleHitCount,
      deltaRevertCount: metric.revertCount - base.revertCount,
      deltaMinimizedCount: metric.minimizedCount - base.minimizedCount
    };
  });
}

export async function runComparisonReport(
  suiteId: string,
  cases: BenchmarkCase[],
  modes: AblationMode[],
  configOverrides?: Partial<CampaignConfig>
): Promise<ComparisonReport> {
  const uniqueModes = Array.from(new Set(["full", ...modes])) as AblationMode[];
  const comparisons: BenchmarkSummary[] = [];

  for (const mode of uniqueModes) {
    comparisons.push(await runBenchmarkSuite(suiteId, cases, { ...configOverrides, ablationMode: mode }));
  }

  const baseline = comparisons.find((entry) => entry.mode === "full");
  if (!baseline) {
    throw new Error("Comparison report requires full mode baseline");
  }

  const deltas = comparisons
    .filter((entry) => entry.mode !== baseline.mode)
    .flatMap((entry) => computeDeltas(baseline, entry));

  return comparisonReportSchema.parse({
    suiteId,
    baselineMode: baseline.mode,
    comparisons,
    deltas
  });
}
