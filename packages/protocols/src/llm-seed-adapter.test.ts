import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { LlmSemanticExtraction } from "../../shared/src/index.js";
import { loadManifest } from "./manifest-loader.js";
import { buildAdvisoryLinks, buildLlmSeedScenarios } from "./llm-seed-adapter.js";
import { analyzeProtocolSemantics } from "./semantic-analysis.js";

const fixture = (rel: string): string =>
  fileURLToPath(new URL(`../../../fixtures/${rel}`, import.meta.url));

const vaultWithdrawAdvisory: LlmSemanticExtraction = {
  protocolSummary: "vault",
  protocolType: "vault",
  keyRisks: [],
  invariantSuggestions: [],
  attackSketches: [
    {
      id: "reserve-drain-seed",
      title: "Reserve drain probe",
      objective: "drain",
      preconditions: [],
      steps: ["withdraw the reserve"],
      targetActions: ["withdraw"],
      confidence: "medium"
    }
  ],
  warnings: []
};

describe("buildLlmSeedScenarios", () => {
  it("converts a vault withdraw sketch into an llm scenario", async () => {
    const manifest = await loadManifest(fixture("protocols/toy-vault/manifest.json"));
    const semantics = analyzeProtocolSemantics(manifest);
    const scenarios = buildLlmSeedScenarios(manifest, semantics, vaultWithdrawAdvisory);

    expect(scenarios).toHaveLength(1);
    const scenario = scenarios[0]!;
    expect(scenario.source).toBe("llm");
    expect(scenario.id).toBe("toy-vault-llm-reserve-drain-seed");
    expect(scenario.assumptions).toContain("llm-sketch:reserve-drain-seed");
    expect(scenario.steps.map((step) => step.actionId)).toEqual([
      "seed-vault-liquidity",
      "user-deposit-usdc",
      "user-withdraw-excess"
    ]);
  });

  it("returns an empty list for a null advisory", async () => {
    const manifest = await loadManifest(fixture("protocols/toy-vault/manifest.json"));
    const semantics = analyzeProtocolSemantics(manifest);
    expect(buildLlmSeedScenarios(manifest, semantics, null)).toEqual([]);
  });
});

describe("buildAdvisoryLinks", () => {
  it("links llm scenarios back to their originating sketch", async () => {
    const manifest = await loadManifest(fixture("protocols/toy-vault/manifest.json"));
    const semantics = analyzeProtocolSemantics(manifest);
    const scenarios = buildLlmSeedScenarios(manifest, semantics, vaultWithdrawAdvisory);

    const links = buildAdvisoryLinks(scenarios, vaultWithdrawAdvisory);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      scenarioId: "toy-vault-llm-reserve-drain-seed",
      advisoryAttackSketchId: "reserve-drain-seed",
      targetActions: ["withdraw"]
    });
  });
});
