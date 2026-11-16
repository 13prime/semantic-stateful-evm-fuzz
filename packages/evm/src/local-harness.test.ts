import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import {
  campaignConfigSchema,
  scenarioSchema,
  type CampaignConfig,
  type ProtocolManifest,
  type Scenario
} from "../../shared/src/index.js";
import { loadManifest } from "../../protocols/src/manifest-loader.js";
import { runLocalHarnessScenario } from "./local-harness.js";

const fixture = (rel: string): string =>
  fileURLToPath(new URL(`../../../fixtures/${rel}`, import.meta.url));

function scenario(id: string, steps: Scenario["steps"]): Scenario {
  return scenarioSchema.parse({ id, source: "template", steps });
}

const baseConfig: CampaignConfig = campaignConfigSchema.parse({
  target: "test",
  execution: { executor: "local-harness" }
});

describe("runLocalHarnessScenario (toy-vault)", () => {
  let vault: ProtocolManifest;

  beforeAll(async () => {
    vault = await loadManifest(fixture("protocols/toy-vault/manifest.json"));
  });

  it("completes a safe redeem without oracle hits", async () => {
    const result = await runLocalHarnessScenario(
      vault,
      scenario("redeem", [
        { actor: "liquidityProvider", actionId: "seed-vault-liquidity", args: { asset: "USDC", amount: 7500 } },
        { actor: "vaultUser", actionId: "user-deposit-usdc", args: { asset: "USDC", amount: 3000 } },
        { actor: "vaultUser", actionId: "user-redeem-safe", args: { asset: "USDC", amount: 1500 } }
      ]),
      baseConfig
    );

    expect(result.status).toBe("ok");
    expect(result.profitDeltaByActor.vaultUser).toBe("1500.00");
    expect(result.protocolLosses.USDC).toBe("1500.00");
    expect(result.invariantFindings.every((finding) => finding.status === "ok")).toBe(true);
  });

  it("flags an excess withdrawal as an economic oracle hit", async () => {
    const result = await runLocalHarnessScenario(
      vault,
      scenario("drain", [
        { actor: "liquidityProvider", actionId: "seed-vault-liquidity", args: { asset: "USDC", amount: 7500 } },
        { actor: "vaultUser", actionId: "user-deposit-usdc", args: { asset: "USDC", amount: 3000 } },
        { actor: "vaultUser", actionId: "user-withdraw-excess", args: { asset: "USDC", amount: 18750 } }
      ]),
      baseConfig
    );

    expect(result.status).toBe("oracle-hit");
    expect(result.profitDeltaByActor.vaultUser).toBe("18750.00");
    expect(result.invariantFindings.map((finding) => finding.invariantId)).toContain("profit:vaultUser");
    expect(result.invariantFindings.map((finding) => finding.invariantId)).toContain("protocol-loss:USDC");
  });

  it("reverts a withdrawal that exceeds reserves", async () => {
    const result = await runLocalHarnessScenario(
      vault,
      scenario("overdraw", [
        { actor: "vaultUser", actionId: "user-withdraw-excess", args: { asset: "USDC", amount: 99999999 } }
      ]),
      baseConfig
    );

    expect(result.status).toBe("revert");
    expect(result.steps[0]?.status).toBe("revert");
  });
});

describe("runLocalHarnessScenario (toy-lending)", () => {
  let lending: ProtocolManifest;

  beforeAll(async () => {
    lending = await loadManifest(fixture("protocols/toy-lending/manifest.json"));
  });

  const oracleCrash = () =>
    scenario("oracle-crash", [
      { actor: "liquidityProvider", actionId: "seed-usdc-liquidity", args: { asset: "USDC", amount: 10000 } },
      { actor: "attacker", actionId: "deposit-eth-collateral", args: { asset: "ETH", amount: 10 } },
      { actor: "attacker", actionId: "borrow-usdc", args: { asset: "USDC", amount: 15000 } },
      { actor: "oracleAdmin", actionId: "slash-eth-price", args: { asset: "ETH", price: 100 } }
    ]);

  it("detects a solvency invariant break after an oracle crash", async () => {
    const result = await runLocalHarnessScenario(lending, oracleCrash(), baseConfig);

    expect(result.status).toBe("invariant-broken");
    const solvency = result.invariantFindings.find((finding) => finding.invariantId === "protocol-solvency");
    expect(solvency?.status).toBe("violated");
  });

  it("includes derived semantic invariants by default", async () => {
    const result = await runLocalHarnessScenario(lending, oracleCrash(), baseConfig);
    const ids = result.invariantFindings.map((finding) => finding.invariantId);
    expect(ids).toContain("toy-lending-derived-collateral-envelope");
  });

  it("suppresses derived invariants under manifest-only-invariants ablation", async () => {
    const config = campaignConfigSchema.parse({
      target: "test",
      ablationMode: "manifest-only-invariants",
      execution: { executor: "local-harness" }
    });
    const result = await runLocalHarnessScenario(lending, oracleCrash(), config);
    const ids = result.invariantFindings.map((finding) => finding.invariantId);
    expect(ids).not.toContain("toy-lending-derived-collateral-envelope");
    expect(ids).toContain("protocol-solvency");
  });
});
