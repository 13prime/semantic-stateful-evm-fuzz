import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { protocolManifestSchema } from "../../shared/src/index.js";
import { analyzeProtocolSemantics } from "./semantic-analysis.js";
import { loadManifest } from "./manifest-loader.js";

const fixture = (rel: string): string =>
  fileURLToPath(new URL(`../../../fixtures/${rel}`, import.meta.url));

describe("analyzeProtocolSemantics", () => {
  it("classifies the toy-vault manifest as a vault", async () => {
    const manifest = await loadManifest(fixture("protocols/toy-vault/manifest.json"));
    const semantics = analyzeProtocolSemantics(manifest);

    expect(semantics.protocolId).toBe("toy-vault");
    expect(semantics.archetype).toBe("vault");
    expect(semantics.actions.map((action) => action.family)).toEqual([
      "supply-liquidity",
      "deposit-collateral",
      "withdraw",
      "withdraw"
    ]);

    // Pin current asset-role inference: USDC resolves to "collateral" for the
    // hand-written vault manifest (no sourceStateVariables metadata present).
    const usdc = semantics.assets.find((asset) => asset.symbol === "USDC");
    expect(usdc?.role).toBe("collateral");
    expect(usdc?.priority).toBe(15000);

    // Manifest conservation invariant plus two derived vault invariants.
    expect(semantics.candidateInvariants.map((invariant) => invariant.kind)).toEqual([
      "conservation",
      "conservation",
      "profit"
    ]);
    expect(semantics.candidateInvariants.map((invariant) => invariant.source)).toEqual([
      "manifest",
      "derived",
      "derived"
    ]);

    expect(semantics.notes).toContain(
      "Protocol exposes value-extraction paths via withdraw-like actions."
    );
  });

  it("classifies the toy-lending manifest as lending with debt/collateral assets", async () => {
    const manifest = await loadManifest(fixture("protocols/toy-lending/manifest.json"));
    const semantics = analyzeProtocolSemantics(manifest);

    expect(semantics.archetype).toBe("lending");

    const eth = semantics.assets.find((asset) => asset.symbol === "ETH");
    const usdc = semantics.assets.find((asset) => asset.symbol === "USDC");
    expect(eth?.role).toBe("collateral");
    expect(usdc?.role).toBe("debt");

    expect(semantics.candidateInvariants.map((invariant) => invariant.kind)).toEqual([
      "solvency",
      "conservation",
      "solvency",
      "profit"
    ]);

    const attacker = semantics.roles.find((role) => role.roleId === "attacker");
    expect(attacker?.notes).toContain("adversarial role");
  });

  it("classifies the toy-amm manifest as an amm with liquidity assets", async () => {
    const manifest = await loadManifest(fixture("protocols/toy-amm/manifest.json"));
    const semantics = analyzeProtocolSemantics(manifest);

    expect(semantics.archetype).toBe("amm");
    expect(semantics.assets.every((asset) => asset.role === "liquidity")).toBe(true);
    expect(semantics.candidateInvariants.map((invariant) => invariant.kind)).toEqual([
      "conservation",
      "conservation",
      "profit"
    ]);
  });

  it("returns the unknown archetype for a featureless manifest", () => {
    const semantics = analyzeProtocolSemantics(
      protocolManifestSchema.parse({
        id: "opaque",
        name: "Opaque",
        chain: "local-harness",
        contracts: [{ name: "Opaque" }],
        roles: [{ id: "user", description: "user", initialBalances: {} }],
        actions: [{ id: "poke", label: "Poke", actorRole: "user", contract: "Opaque", method: "poke" }],
        invariants: [],
        metadata: {}
      })
    );

    expect(semantics.archetype).toBe("unknown");
  });
});
