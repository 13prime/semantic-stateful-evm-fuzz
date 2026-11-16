import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { bootstrapManifestFromAbi, buildManifestBootstrap } from "./abi-bootstrap.js";
import { bootstrapManifestFromSource } from "./source-bootstrap.js";

const fixture = (rel: string): string =>
  fileURLToPath(new URL(`../../../fixtures/${rel}`, import.meta.url));

describe("buildManifestBootstrap", () => {
  it("derives a lending manifest from borrow/deposit function specs", () => {
    const manifest = buildManifestBootstrap(
      [
        { name: "deposit", inputs: [{ name: "amount", type: "uint256" }] },
        { name: "borrow", inputs: [{ name: "amount", type: "uint256" }] },
        { name: "repay", inputs: [{ name: "amount", type: "uint256" }] }
      ],
      "LendingPool"
    );

    // slugify does not split camelCase, so "LendingPool" stays as one token.
    expect(manifest.id).toBe("lendingpool");
    expect(manifest.name).toBe("LendingPool");
    expect(manifest.metadata.inferredArchetype).toBe("lending");
    expect(manifest.actions.map((action) => action.method)).toEqual(["deposit", "borrow", "repay"]);
    expect(manifest.invariants.some((invariant) => invariant.kind === "solvency")).toBe(true);
  });

  it("derives a vault manifest from deposit/redeem function specs", () => {
    const manifest = buildManifestBootstrap(
      [
        { name: "deposit", inputs: [{ name: "amount", type: "uint256" }] },
        { name: "redeem", inputs: [{ name: "shares", type: "uint256" }] }
      ],
      "ToyVault"
    );

    expect(manifest.metadata.inferredArchetype).toBe("vault");
    expect(manifest.actions.find((action) => action.id === "redeem")?.method).toBe("withdraw");
    expect(manifest.invariants.some((invariant) => invariant.kind === "conservation")).toBe(true);
  });
});

describe("bootstrapManifestFromAbi", () => {
  it("bootstraps a manifest from the sample vault ABI", async () => {
    const manifest = await bootstrapManifestFromAbi(fixture("sample-vault.abi.json"));

    expect(manifest.id).toBe("sample-vault");
    expect(manifest.metadata.inferredArchetype).toBe("vault");
    expect(manifest.actions.map((action) => action.id)).toEqual([
      "deposit",
      "redeem",
      "withdrawexcess"
    ]);
  });
});

describe("bootstrapManifestFromSource", () => {
  it("bootstraps a manifest with source metadata from Solidity", async () => {
    const manifest = await bootstrapManifestFromSource(fixture("sample-vault.sol"));

    expect(manifest.contracts[0]?.name).toBe("SampleVault");
    expect(manifest.metadata.inferredArchetype).toBe("vault");
    expect(manifest.metadata.sourceStateVariables).toContain("totalAssets");
    expect(manifest.metadata.sourceStateVariables).toContain("totalShares");
    expect(manifest.metadata.sourceStateVariables).toContain("totalReserves");
    expect(manifest.metadata.sourceConstructorPresent).toBe(false);
  });
});
