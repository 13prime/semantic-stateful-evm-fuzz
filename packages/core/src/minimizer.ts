import type { ExecutionResult, Scenario } from "../../shared/src/index.js";
import { minimizeScenario } from "./corpus.js";

function isInteresting(result: ExecutionResult): boolean {
  return result.status === "oracle-hit" || result.status === "invariant-broken";
}

export async function minimizeInterestingScenario(
  scenario: Scenario,
  execute: (candidate: Scenario) => Promise<ExecutionResult>
): Promise<{ minimizedScenario: Scenario; result: ExecutionResult } | null> {
  const candidates = minimizeScenario(scenario);
  let bestScenario: Scenario | null = null;
  let bestResult: ExecutionResult | null = null;

  for (const candidate of candidates) {
    const result = await execute(candidate);
    if (!isInteresting(result)) {
      continue;
    }

    if (!bestScenario || candidate.steps.length < bestScenario.steps.length) {
      bestScenario = candidate;
      bestResult = result;
    }
  }

  if (!bestScenario || !bestResult) {
    return null;
  }

  return {
    minimizedScenario: bestScenario,
    result: bestResult
  };
}
