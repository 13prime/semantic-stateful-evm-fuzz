import { describe, expect, it } from "vitest";

import {
  executionResultSchema,
  scenarioSchema,
  type ExecutionResult,
  type Scenario
} from "../../shared/src/index.js";
import { expandScenarioCorpus, minimizeScenario, selectInterestingScenarios } from "./corpus.js";

function result(scenarioId: string, status: ExecutionResult["status"], violated = 0): ExecutionResult {
  return executionResultSchema.parse({
    scenarioId,
    status,
    steps: [],
    invariantFindings: Array.from({ length: violated }, (_, index) => ({
      invariantId: `i-${index}`,
      status: "violated",
      message: "violated",
      severity: "critical"
    })),
    summary: "summary"
  });
}

function scenario(id: string, steps: Scenario["steps"]): Scenario {
  return scenarioSchema.parse({ id, source: "template", steps });
}

describe("selectInterestingScenarios", () => {
  it("orders scenarios by interestingness and truncates to the limit", () => {
    const scenarios = [
      scenario("ok", [{ actor: "a", actionId: "x", args: {} }]),
      scenario("broken", [{ actor: "a", actionId: "x", args: {} }]),
      scenario("reverted", [{ actor: "a", actionId: "x", args: {} }])
    ];
    const results = [result("ok", "ok"), result("broken", "invariant-broken", 1), result("reverted", "revert")];

    expect(selectInterestingScenarios(scenarios, results, 2).map((entry) => entry.id)).toEqual([
      "broken",
      "reverted"
    ]);
  });
});

describe("expandScenarioCorpus", () => {
  it("produces soften and amplify mutations per seed", () => {
    const seed = scenario("seed", [
      { actor: "a", actionId: "borrow", args: { amount: 100 } },
      { actor: "a", actionId: "price", args: { price: 50 } }
    ]);

    const expanded = expandScenarioCorpus([seed], 1);
    expect(expanded).toHaveLength(2);

    const soften = expanded.find((entry) => entry.id === "seed-corpus-r1-soften");
    const amplify = expanded.find((entry) => entry.id === "seed-corpus-r1-amplify");
    expect(soften?.steps[0]?.args.amount).toBe(80);
    expect(soften?.steps[1]?.args.price).toBe(38);
    expect(amplify?.steps[0]?.args.amount).toBe(120);
    expect(amplify?.steps[1]?.args.price).toBe(25);
    expect(amplify?.source).toBe("mutation");
  });
});

describe("minimizeScenario", () => {
  it("drops each step and halves amounts", () => {
    const seed = scenario("seed", [
      { actor: "a", actionId: "s1", args: { amount: 100 } },
      { actor: "a", actionId: "s2", args: { amount: 100 } },
      { actor: "a", actionId: "s3", args: { amount: 100 } }
    ]);

    const candidates = minimizeScenario(seed);
    expect(candidates).toHaveLength(4);
    expect(candidates.filter((entry) => entry.steps.length === 2)).toHaveLength(3);
    expect(candidates.some((entry) => entry.id === "seed-min-amount-half")).toBe(true);
  });
});
