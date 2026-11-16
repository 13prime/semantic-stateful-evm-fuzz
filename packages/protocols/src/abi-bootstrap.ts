import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  abiInputSchema,
  abiManifestBootstrapSchema,
  protocolManifestSchema,
  type AbiInput,
  type AbiManifestBootstrap,
  type ProtocolManifest
} from "../../shared/src/index.js";

export interface FunctionBootstrapInput {
  name: string;
  inputs: Array<{ name?: string; type: string }>;
  visibility?: string;
  stateMutability?: string;
  modifiers?: string[];
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "protocol";
}

function humanize(name: string): string {
  return name
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function normalizeContractName(rawContractName: string): string {
  return rawContractName.replace(/\.abi$/i, "");
}

function inferArchetype(functionNames: string[]): "lending" | "vault" | "amm" | "unknown" {
  const lowerNames = functionNames.map((name) => name.toLowerCase());
  if (lowerNames.some((name) => name.includes("borrow") || name.includes("repay") || name.includes("liquidat"))) {
    return "lending";
  }
  if (
    lowerNames.some((name) => name.includes("deposit") || name.includes("mint") || name.includes("supply"))
    && lowerNames.some((name) => name.includes("withdraw") || name.includes("redeem"))
  ) {
    return "vault";
  }
  if (lowerNames.some((name) => name.includes("swap"))) {
    return "amm";
  }
  return "unknown";
}

function inferAssetSymbols(functionNames: string[], contractName: string, archetype: ReturnType<typeof inferArchetype>) {
  const lowerNames = functionNames.map((name) => name.toLowerCase()).join(" ");
  const lowerContract = contractName.toLowerCase();

  const hasUsdc = lowerNames.includes("usdc") || lowerContract.includes("usdc") || lowerContract.includes("stable");
  const hasEth = lowerNames.includes("eth") || lowerContract.includes("eth") || lowerContract.includes("weth");
  const hasBtc = lowerNames.includes("btc") || lowerContract.includes("btc") || lowerContract.includes("wbtc");

  const underlying = hasUsdc ? "USDC" : hasEth ? "ETH" : hasBtc ? "WBTC" : archetype === "vault" ? "UNDERLYING" : "TOKEN";
  const collateral = hasEth ? "ETH" : hasBtc ? "WBTC" : "COLLATERAL";
  const debt = hasUsdc ? "USDC" : hasEth ? "WETH" : "DEBT_TOKEN";

  return { underlying, collateral, debt };
}

function inferAssetDecimals(symbol: string): number {
  if (symbol === "USDC" || symbol === "USDT") {
    return 6;
  }
  return 18;
}

function hasPrivilegedModifier(modifiers: string[] = []): boolean {
  return modifiers.some((modifier) => /owner|admin|govern|guardian|operator/i.test(modifier));
}

function deriveActionRole(functionSpec: FunctionBootstrapInput, archetype: ReturnType<typeof inferArchetype>): string {
  const lower = functionSpec.name.toLowerCase();
  const visibility = functionSpec.visibility?.toLowerCase();
  const privileged = hasPrivilegedModifier(functionSpec.modifiers);
  const adminLike = privileged || lower.includes("owner") || lower.includes("admin") || lower.includes("pause") || lower.includes("set") || lower.includes("emergency") || lower.includes("rescue") || lower.includes("sweep") || visibility === "internal" || visibility === "private";
  const oracleLike = lower.includes("oracle") || lower.includes("price");

  if (adminLike || oracleLike) {
    return oracleLike ? "oracleAdmin" : "admin";
  }
  if (lower.includes("seed") || lower.includes("liquidity")) {
    return "liquidityProvider";
  }
  if (lower.includes("borrow")) {
    return "attacker";
  }
  if (archetype === "vault" && (lower.includes("deposit") || lower.includes("withdraw") || lower.includes("redeem") || lower.includes("mint"))) {
    return "vaultUser";
  }
  return "user";
}

function deriveActionMethod(functionName: string): string {
  const lower = functionName.toLowerCase();
  if (lower.includes("redeem") || lower.includes("withdraw")) {
    return "withdraw";
  }
  if (lower.includes("deposit") || lower.includes("mint") || lower.includes("supply") || lower.includes("seed")) {
    return "deposit";
  }
  if (lower.includes("borrow")) {
    return "borrow";
  }
  if (lower.includes("repay")) {
    return "repay";
  }
  if (lower.includes("price") || lower.includes("oracle")) {
    return "setPrice";
  }
  return functionName;
}

function deriveActionConfig(
  functionName: string,
  archetype: ReturnType<typeof inferArchetype>,
  assets: ReturnType<typeof inferAssetSymbols>,
  functionSpec: FunctionBootstrapInput
): Record<string, unknown> {
  const lower = functionName.toLowerCase();
  const privileged = hasPrivilegedModifier(functionSpec.modifiers);

  if (lower.includes("seed") || lower.includes("liquidity")) {
    return { depositKind: "liquidity", asset: archetype === "vault" ? assets.underlying : assets.debt };
  }
  if (lower.includes("deposit") || lower.includes("mint") || lower.includes("supply")) {
    return {
      depositKind: archetype === "lending" ? "collateral" : "position",
      asset: archetype === "lending" ? assets.collateral : assets.underlying
    };
  }
  if (lower.includes("withdraw") || lower.includes("redeem")) {
    return {
      withdrawKind: privileged || lower.includes("excess") || lower.includes("drain") ? "drain" : "position",
      asset: archetype === "lending" ? assets.debt : assets.underlying,
      privileged
    };
  }
  if (lower.includes("borrow") || lower.includes("repay")) {
    return { asset: assets.debt };
  }
  if (lower.includes("price") || lower.includes("oracle")) {
    return { asset: assets.collateral, privileged };
  }
  return { privileged };
}

function deriveActionHints(functionName: string, archetype: ReturnType<typeof inferArchetype>, functionSpec: FunctionBootstrapInput): string[] {
  const lower = functionName.toLowerCase();
  const hints: string[] = [];

  if (archetype === "lending") {
    if (lower.includes("borrow")) {
      hints.push("increase user debt", "decrease protocol reserves");
    }
    if (lower.includes("deposit")) {
      hints.push("increase collateral support");
    }
    if (lower.includes("repay")) {
      hints.push("decrease user debt", "increase protocol reserves");
    }
    if (lower.includes("price") || lower.includes("oracle")) {
      hints.push("change collateral valuation");
    }
  }
  if (archetype === "vault") {
    if (lower.includes("deposit") || lower.includes("mint")) {
      hints.push("increase vault user position");
    }
    if (lower.includes("withdraw") || lower.includes("redeem")) {
      hints.push("decrease vault reserves", "transfer underlying to user");
    }
  }
  if (hasPrivilegedModifier(functionSpec.modifiers)) {
    hints.push("requires privileged role");
  }
  return hints;
}

function deriveInvariantHints(
  functionNames: string[],
  archetype: ReturnType<typeof inferArchetype>,
  assets: ReturnType<typeof inferAssetSymbols>
) {
  const lowerNames = functionNames.map((name) => name.toLowerCase());
  const invariants = [] as AbiManifestBootstrap["invariants"];

  if (archetype === "lending" || lowerNames.some((name) => name.includes("borrow"))) {
    invariants.push({
      id: "bootstrap-solvency",
      kind: "solvency",
      description: "Borrow-capable flows should remain collateralized.",
      severity: "high",
      config: { collateralAsset: assets.collateral, debtAsset: assets.debt }
    });
  }

  if (archetype === "vault" || lowerNames.some((name) => name.includes("withdraw") || name.includes("redeem"))) {
    invariants.push({
      id: "bootstrap-conservation",
      kind: "conservation",
      description: "Withdraw-like flows should not overdraw protocol reserves.",
      severity: "high",
      config: { asset: archetype === "vault" ? assets.underlying : assets.debt }
    });
  }

  return invariants;
}

function deriveProtocolName(contractName: string): string {
  return humanize(contractName);
}

function deriveContractTags(functionNames: string[], archetype: ReturnType<typeof inferArchetype>): string[] {
  const tags = new Set<string>();
  const lowerNames = functionNames.map((name) => name.toLowerCase());

  if (archetype !== "unknown") {
    tags.add(archetype);
  }
  if (lowerNames.some((name) => name.includes("oracle") || name.includes("price"))) {
    tags.add("oracle-sensitive");
  }
  if (tags.size === 0) {
    tags.add("protocol");
  }

  return [...tags];
}

function deriveAssets(archetype: ReturnType<typeof inferArchetype>, inferred: ReturnType<typeof inferAssetSymbols>) {
  if (archetype === "lending") {
    return [
      { symbol: inferred.collateral, decimals: inferAssetDecimals(inferred.collateral), priceSource: "Oracle" },
      { symbol: inferred.debt, decimals: inferAssetDecimals(inferred.debt), priceSource: "Oracle" }
    ];
  }

  return [{ symbol: inferred.underlying, decimals: inferAssetDecimals(inferred.underlying) }];
}

function deriveRoles(archetype: ReturnType<typeof inferArchetype>, inferredAssets: ReturnType<typeof inferAssetSymbols>) {
  if (archetype === "lending") {
    return [
      {
        id: "liquidityProvider",
        description: "Initial depositor seeding protocol liquidity",
        initialBalances: { [inferredAssets.debt]: "50000", [inferredAssets.collateral]: "0" }
      },
      {
        id: "attacker",
        description: "Adversarial borrower or withdrawer discovered from ABI actions",
        initialBalances: { [inferredAssets.collateral]: "10000", [inferredAssets.debt]: "1000" }
      },
      {
        id: "oracleAdmin",
        description: "Administrative role for oracle or owner-like functions",
        initialBalances: { [inferredAssets.collateral]: "0", [inferredAssets.debt]: "0" }
      }
    ];
  }

  if (archetype === "vault") {
    return [
      {
        id: "liquidityProvider",
        description: "Initial depositor providing vault liquidity",
        initialBalances: { [inferredAssets.underlying]: "50000" }
      },
      {
        id: "vaultUser",
        description: "Vault participant depositing and withdrawing underlying",
        initialBalances: { [inferredAssets.underlying]: "10000" }
      },
      {
        id: "admin",
        description: "Administrative role for owner-like functions",
        initialBalances: { [inferredAssets.underlying]: "0" }
      }
    ];
  }

  return [
    {
      id: "user",
      description: "Default user interacting with ABI-discovered actions",
      initialBalances: { [inferredAssets.underlying]: "10000" }
    },
    {
      id: "admin",
      description: "Administrative role for owner-like functions",
      initialBalances: { [inferredAssets.underlying]: "0" }
    }
  ];
}

function deriveMetadata(archetype: ReturnType<typeof inferArchetype>, inferredAssets: ReturnType<typeof inferAssetSymbols>) {
  if (archetype === "lending") {
    return {
      initialReserves: { [inferredAssets.debt]: 15000, [inferredAssets.collateral]: 0 },
      initialPrices: { [inferredAssets.collateral]: inferredAssets.collateral === "ETH" ? 2000 : 1000, [inferredAssets.debt]: 1 },
      collateralFactor: 0.8,
      profitAlertThreshold: 5000,
      protocolLossAlertThreshold: 5000
    };
  }

  if (archetype === "vault") {
    return {
      initialReserves: { [inferredAssets.underlying]: 15000 },
      initialPrices: { [inferredAssets.underlying]: 1 },
      profitAlertThreshold: 2000,
      protocolLossAlertThreshold: 2000
    };
  }

  return {};
}

export function buildManifestBootstrap(
  functionSpecs: FunctionBootstrapInput[],
  contractName: string,
  options?: { outputId?: string; chain?: "local-harness" | "anvil"; sourcePath?: string; sourceType?: string }
): ProtocolManifest {
  const protocolName = deriveProtocolName(contractName);
  const protocolId = options?.outputId ?? slugify(protocolName);
  const functionNames = functionSpecs.map((entry) => entry.name ?? "unknown");
  const archetype = inferArchetype(functionNames);
  const inferredAssets = inferAssetSymbols(functionNames, contractName, archetype);
  const assets = deriveAssets(archetype, inferredAssets);
  const roles = deriveRoles(archetype, inferredAssets);

  const bootstrap = abiManifestBootstrapSchema.parse({
    id: protocolId,
    name: protocolName,
    chain: options?.chain ?? "local-harness",
    contracts: [
      {
        name: contractName,
        tags: deriveContractTags(functionNames, archetype)
      }
    ],
    assets,
    roles,
    actions: functionSpecs.map((entry) => ({
      id: slugify(entry.name ?? "unknown"),
      label: humanize(entry.name ?? "unknown"),
      actorRole: deriveActionRole(entry, archetype),
      contract: contractName,
      method: deriveActionMethod(entry.name ?? "unknown"),
      argsSchema: Object.fromEntries((entry.inputs ?? []).map((input) => [input.name || input.type, input.type])),
      effectsHint: deriveActionHints(entry.name ?? "unknown", archetype, entry),
      config: deriveActionConfig(entry.name ?? "unknown", archetype, inferredAssets, entry)
    })),
    invariants: deriveInvariantHints(functionNames, archetype, inferredAssets),
    metadata: {
      source: options?.sourceType ?? "abi-bootstrap",
      inferredArchetype: archetype,
      ...(options?.sourcePath ? { sourcePath: options.sourcePath } : {}),
      ...deriveMetadata(archetype, inferredAssets)
    }
  });

  return protocolManifestSchema.parse(bootstrap);
}

export async function bootstrapManifestFromAbi(
  abiPath: string,
  options?: { contractName?: string; outputId?: string; chain?: "local-harness" | "anvil" }
): Promise<ProtocolManifest> {
  const raw = await readFile(abiPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const abiEntries = Array.isArray(parsed) ? parsed.map((entry) => abiInputSchema.parse(entry)) : [];
  const functions = abiEntries.filter((entry) => entry.type === "function" && entry.name).map((entry) => ({
    name: entry.name as string,
    inputs: entry.inputs ?? [],
    stateMutability: entry.stateMutability
  }));

  const inferredContractName = normalizeContractName(
    options?.contractName ?? path.basename(abiPath).replace(path.extname(abiPath), "") ?? "Contract"
  );

  return buildManifestBootstrap(functions, inferredContractName, {
    outputId: options?.outputId,
    chain: options?.chain,
    sourcePath: abiPath,
    sourceType: "abi-bootstrap"
  });
}
