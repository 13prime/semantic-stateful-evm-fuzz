import { scenarioSchema, type ExecutionResult, type Scenario } from "../../shared/src/index.js";

function numericMax(values: Record<string, string>): number {
  return Math.max(0, ...Object.values(values).map((value) => Number(value)));
}

function interestingScore(result: ExecutionResult): number {
  const violated = result.invariantFindings.filter((finding) => finding.status === "violated").length;
  const statusScore = result.status === "invariant-broken" ? 300 : result.status === "oracle-hit" ? 200 : result.status === "revert" ? 25 : 0;
  return statusScore + violated * 20 + numericMax(result.profitDeltaByActor) / 100 + numericMax(result.protocolLosses) / 100;
}

export function selectInterestingScenarios(
  scenarios: Scenario[],
  results: ExecutionResult[],
  limit: number
): Scenario[] {
  const scenarioById = new Map(scenarios.map((scenario) => [scenario.id, scenario]));

  return [...results]
    .sort((left, right) => interestingScore(right) - interestingScore(left))
    .map((result) => scenarioById.get(result.scenarioId))
    .filter((scenario): scenario is Scenario => Boolean(scenario))
    .slice(0, limit);
}

function mutateNumericFields(
  scenario: Scenario,
  originId: string,
  suffix: string,
  transform: (current: number, key: string) => number
): Scenario {
  return scenarioSchema.parse({
    ...scenario,
    id: `${scenario.id}-${suffix}`,
    source: "mutation",
    tags: [...scenario.tags, "corpus", suffix],
    assumptions: [...scenario.assumptions, `origin:${originId}`],
    steps: scenario.steps.map((step) => ({
      ...step,
      args: Object.fromEntries(
        Object.entries(step.args).map(([key, value]) => {
          if ((key !== "amount" && key !== "price") || typeof value !== "number") {
            return [key, value];
          }
          return [key, Math.max(1, Math.round(transform(value, key)))];
        })
      )
    }))
  });
}

export function expandScenarioCorpus(seedScenarios: Scenario[], round: number): Scenario[] {
  const expanded: Scenario[] = [];

  for (const scenario of seedScenarios) {
    expanded.push(
      mutateNumericFields(scenario, scenario.id, `corpus-r${round}-soften`, (value, key) => {
        if (key === "price") {
          return value * 0.75;
        }
        return value * 0.8;
      })
    );

    expanded.push(
      mutateNumericFields(scenario, scenario.id, `corpus-r${round}-amplify`, (value, key) => {
        if (key === "price") {
          return value * 0.5;
        }
        return value * 1.2;
      })
    );
  }

  return expanded;
}

export function minimizeScenario(original: Scenario): Scenario[] {
  const candidates: Scenario[] = [];

  if (original.steps.length > 1) {
    for (let index = 0; index < original.steps.length; index += 1) {
      candidates.push(
        scenarioSchema.parse({
          ...original,
          id: `${original.id}-min-drop-${index}`,
          source: "mutation",
          tags: [...original.tags, "minimized", `drop-${index}`],
          assumptions: [...original.assumptions, `origin:${original.id}`],
          steps: original.steps.filter((_, stepIndex) => stepIndex !== index)
        })
      );
    }
  }

  candidates.push(
    mutateNumericFields(original, original.id, "min-amount-half", (value, key) => {
      if (key === "price") {
        return value;
      }
      return value * 0.5;
    })
  );

  return candidates;
}
