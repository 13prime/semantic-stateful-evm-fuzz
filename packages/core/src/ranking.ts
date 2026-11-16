import type { AdvisoryLink, ExecutionResult } from "../../shared/src/index.js";

const statusWeight = {
  ok: 0,
  revert: 1,
  "oracle-hit": 2,
  "invariant-broken": 3
} as const;

function highestNumericValue(values: Record<string, string>): number {
  return Math.max(0, ...Object.values(values).map((value) => Number(value)));
}

function advisoryBonus(result: ExecutionResult, advisoryLinks: AdvisoryLink[] = []): number {
  const advisory = advisoryLinks.find((link) => link.scenarioId === result.scenarioId);
  if (!advisory) {
    return 0;
  }

  if (advisory.advisoryAttackSketchTitle.includes("high")) {
    return 25_000;
  }

  if (advisory.advisoryAttackSketchTitle.includes("medium")) {
    return 10_000;
  }

  return 5_000;
}

export function scoreResult(result: ExecutionResult, advisoryLinks: AdvisoryLink[] = []): number {
  const violationCount = result.invariantFindings.filter((finding) => finding.status === "violated").length;
  const attackerProfit = highestNumericValue(result.profitDeltaByActor);
  const protocolLoss = highestNumericValue(result.protocolLosses);

  return (
    statusWeight[result.status] * 1_000_000 +
    violationCount * 10_000 +
    advisoryBonus(result, advisoryLinks) +
    attackerProfit * 10 +
    protocolLoss
  );
}

export function rankResults(results: ExecutionResult[], advisoryLinks: AdvisoryLink[] = []): ExecutionResult[] {
  return [...results].sort((left, right) => scoreResult(right, advisoryLinks) - scoreResult(left, advisoryLinks));
}
