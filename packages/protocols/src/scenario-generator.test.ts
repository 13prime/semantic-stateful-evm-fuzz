import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { campaignConfigSchema, type CampaignConfig } from "../../shared/src/index.js";
import { loadManifest } from "./manifest-loader.js";
import { buildScenarioCatalog, buildSeedScenarios } from "./scenario-generator.js";

const fixture = (rel: string): string =>
  fileURLToPath(new URL(`../../../fixtures/${rel}`, import.meta.url));

const baseConfig: CampaignConfig = campaignConfigSchema.parse({
  target: "fixtures/protocols/toy-vault/manifest.json",
  execution: { executor: "local-harness" }
});

describe("buildSeedScenarios", () => {
  it("generates vault redeem/drain scenarios plus numeric mutations", async () => {
    const manifest = await loadManifest(fixture("protocols/toy-vault/manifest.json"));
    const scenarios = buildSeedScenarios(manifest, baseConfig);

    const ids = scenarios.map((scenario) => scenario.id);
    expect(ids).toContain("toy-vault-generated-vault-redeem");
    expect(ids).toContain("toy-vault-generated-vault-drain");

    const redeem = scenarios.find((scenario) => scenario.id === "toy-vault-generated-vault-redeem");
    expect(redeem?.steps.map((step) => step.actionId)).toEqual([
      "seed-vault-liquidity",
      "user-deposit-usdc",
      "user-redeem-safe"
    ]);

    // Drain and redeem both mutate their withdraw amount.
    expect(scenarios.some((scenario) => scenario.source === "mutation")).toBe(true);
    expect(scenarios.filter((scenario) => scenario.source === "mutation").length).toBe(2);
    expect(scenarios.length).toBe(4);
  });

  it("generates lending scenarios including an oracle-crash mutation", async () => {
    const manifest = await loadManifest(fixture("protocols/toy-lending/manifest.json"));
    const scenarios = buildSeedScenarios(manifest, baseConfig);

    const ids = scenarios.map((scenario) => scenario.id);
    expect(ids).toContain("toy-lending-generated-healthy-borrow");
    expect(ids).toContain("toy-lending-generated-oracle-crash");
    expect(ids).toContain("toy-lending-generated-reserve-drain");
    expect(scenarios.some((scenario) => scenario.source === "mutation")).toBe(true);
  });

  it("generates amm swap scenarios", async () => {
    const manifest = await loadManifest(fixture("protocols/toy-amm/manifest.json"));
    const scenarios = buildSeedScenarios(manifest, baseConfig);

    const ids = scenarios.map((scenario) => scenario.id);
    expect(ids).toContain("toy-amm-generated-amm-swap-roundtrip");
    expect(ids).toContain("toy-amm-generated-amm-reserve-shift");
    expect(ids).toContain("toy-amm-generated-amm-price-shock");
  });
});

describe("buildScenarioCatalog", () => {
  it("maps scenarios to catalog entries with step counts", async () => {
    const manifest = await loadManifest(fixture("protocols/toy-vault/manifest.json"));
    const scenarios = buildSeedScenarios(manifest, baseConfig);
    const catalog = buildScenarioCatalog(scenarios);

    expect(catalog).toHaveLength(scenarios.length);
    const redeem = catalog.find((entry) => entry.id === "toy-vault-generated-vault-redeem");
    expect(redeem?.stepCount).toBe(3);
    expect(redeem?.source).toBe("template");
    expect(redeem?.goal).toBe("profit");
  });
});
