import { describe, expect, it } from "vitest";

import { executionResultSchema, type AdvisoryLink, type ExecutionResult } from "../../shared/src/index.js";
import { rankResults, scoreResult } from "./ranking.js";

function result(
  scenarioId: string,
  status: ExecutionResult["status"],
  profit: Record<string, string> = {},
  losses: Record<string, string> = {}
): ExecutionResult {
  return executionResultSchema.parse({
    scenarioId,
    status,
    steps: [],
    profitDeltaByActor: profit,
    protocolLosses: losses,
    invariantFindings: [],
    summary: "summary"
  });
}

describe("scoreResult", () => {
  it("weights status highest, then profit and losses", () => {
    const broken = scoreResult(result("a", "invariant-broken"));
    const hit = scoreResult(result("b", "oracle-hit"));
    const ok = scoreResult(result("c", "ok"));

    expect(broken).toBeGreaterThan(hit);
    expect(hit).toBeGreaterThan(ok);
  });

  it("adds an advisory bonus for linked scenarios", () => {
    const plain = result("a", "oracle-hit");
    const link: AdvisoryLink = {
      scenarioId: "a",
      advisoryAttackSketchId: "sketch",
      advisoryAttackSketchTitle: "high confidence sketch",
      targetActions: []
    };
    expect(scoreResult(plain, [link])).toBeGreaterThan(scoreResult(plain));
  });
});

describe("rankResults", () => {
  it("sorts by descending score", () => {
    const results = [result("ok", "ok"), result("hit", "oracle-hit"), result("broken", "invariant-broken")];
    expect(rankResults(results).map((entry) => entry.scenarioId)).toEqual(["broken", "hit", "ok"]);
  });
});
