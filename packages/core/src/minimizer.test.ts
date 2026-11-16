import { describe, expect, it } from "vitest";

import { executionResultSchema, scenarioSchema, type ExecutionResult } from "../../shared/src/index.js";
import { minimizeInterestingScenario } from "./minimizer.js";

function interesting(scenarioId: string): ExecutionResult {
  return executionResultSchema.parse({
    scenarioId,
    status: "oracle-hit",
    steps: [],
    invariantFindings: [],
    summary: "summary"
  });
}

const original = scenarioSchema.parse({
  id: "seed",
  source: "template",
  steps: [
    { actor: "a", actionId: "s1", args: { amount: 100 } },
    { actor: "a", actionId: "s2", args: { amount: 100 } },
    { actor: "a", actionId: "s3", args: { amount: 100 } }
  ]
});

describe("minimizeInterestingScenario", () => {
  it("keeps the smallest candidate that stays interesting", async () => {
    const minimized = await minimizeInterestingScenario(original, async (candidate) => interesting(candidate.id));

    expect(minimized).not.toBeNull();
    expect(minimized?.minimizedScenario.id).toBe("seed-min-drop-0");
    expect(minimized?.minimizedScenario.steps).toHaveLength(2);
    expect(minimized?.result.status).toBe("oracle-hit");
  });

  it("returns null when no candidate stays interesting", async () => {
    const minimized = await minimizeInterestingScenario(original, async () =>
      executionResultSchema.parse({
        scenarioId: "candidate",
        status: "ok",
        steps: [],
        invariantFindings: [],
        summary: "summary"
      })
    );

    expect(minimized).toBeNull();
  });
});
