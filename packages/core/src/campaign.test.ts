import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { campaignConfigSchema, type CampaignConfig, type ProtocolManifest } from "../../shared/src/index.js";
import { loadManifest } from "../../protocols/src/manifest-loader.js";
import {
  buildCampaignScenarios,
  executeCampaign,
  replayScenario,
  resolveCampaignInputs
} from "./campaign.js";

const fixture = (rel: string): string =>
  fileURLToPath(new URL(`../../../fixtures/${rel}`, import.meta.url));

function config(artifactDir: string, overrides: Partial<CampaignConfig> = {}): CampaignConfig {
  return campaignConfigSchema.parse({
    target: "fixtures/protocols/toy-vault/manifest.json",
    execution: { executor: "local-harness" },
    artifactDir,
    ...overrides
  });
}

describe("campaign pipeline", () => {
  let vault: ProtocolManifest;
  let artifactDir: string;

  beforeAll(async () => {
    vault = await loadManifest(fixture("protocols/toy-vault/manifest.json"));
    artifactDir = await mkdtemp(path.join(os.tmpdir(), "fuzz-campaign-"));
  });

  afterAll(async () => {
    await rm(artifactDir, { recursive: true, force: true });
  });

  it("resolves campaign inputs with a stub advisory by default", async () => {
    const inputs = await resolveCampaignInputs(vault, config(artifactDir));

    expect(inputs.mode).toBe("full");
    expect(inputs.semantics.archetype).toBe("vault");
    expect(inputs.advisory).not.toBeNull();
    expect(inputs.initialScenarios.length).toBeGreaterThan(0);
  });

  it("produces a null advisory under no-llm ablation", async () => {
    const inputs = await resolveCampaignInputs(
      vault,
      config(artifactDir, { ablationMode: "no-llm" })
    );
    expect(inputs.advisory).toBeNull();
  });

  it("builds a campaign scenario set including llm seeds and corpus mutations", async () => {
    const scenarios = await buildCampaignScenarios(vault, config(artifactDir));
    const sources = new Set(scenarios.map((scenario) => scenario.source));

    expect(scenarios.length).toBeGreaterThan(0);
    expect(sources.has("llm")).toBe(true);
    expect(sources.has("mutation")).toBe(true);
  });

  it("executes a full campaign and persists artifacts", async () => {
    const result = await executeCampaign(vault, config(artifactDir));

    expect(result.manifestId).toBe("toy-vault");
    expect(result.scenarioCount).toBe(result.results.length);
    expect(["ok", "revert", "oracle-hit", "invariant-broken"]).toContain(result.summary.topStatus);

    const scenarioArtifacts = await readdir(path.join(artifactDir, "toy-vault"));
    expect(scenarioArtifacts.length).toBeGreaterThan(0);
  });

  it("replays a known scenario id", async () => {
    const replay = await replayScenario(vault, config(artifactDir), "toy-vault-generated-vault-redeem");

    expect(replay.scenario.id).toBe("toy-vault-generated-vault-redeem");
    expect(replay.result.scenarioId).toBe("toy-vault-generated-vault-redeem");
  });

  it("throws for an unknown scenario id", async () => {
    await expect(replayScenario(vault, config(artifactDir), "does-not-exist")).rejects.toThrow(
      "Unknown scenario id"
    );
  });
});
