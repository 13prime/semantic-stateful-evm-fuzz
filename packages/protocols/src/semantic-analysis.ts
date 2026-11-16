import {
  semanticModelSchema,
  type ActionSpec,
  type ProtocolManifest,
  type SemanticAction,
  type SemanticAsset,
  type SemanticInvariant,
  type SemanticModel
} from "../../shared/src/index.js";

interface AnalysisMetadata {
  initialReserves?: Record<string, number>;
  initialPrices?: Record<string, number>;
  sourceStateVariables?: string[];
  sourceFunctionVisibility?: Record<string, string>;
  sourceFunctionMutability?: Record<string, string>;
  sourceFunctionModifiers?: Record<string, string[]>;
  sourceConstructorPresent?: boolean;
}

function getMetadata(manifest: ProtocolManifest): AnalysisMetadata {
  return manifest.metadata as AnalysisMetadata;
}

function inferArchetype(manifest: ProtocolManifest): SemanticModel["archetype"] {
  const methodNames = manifest.actions.map((action) => action.method.toLowerCase());
  const stateVariables = getMetadata(manifest).sourceStateVariables?.map((name) => name.toLowerCase()) ?? [];

  if (
    methodNames.some((name) => name.includes("borrow") || name.includes("repay") || name.includes("liquidat"))
    || stateVariables.some((name) => name.includes("collateral") || name.includes("debt"))
  ) {
    return "lending";
  }
  if (
    (
      methodNames.some((name) => name.includes("deposit") || name.includes("mint") || name.includes("supply"))
      && methodNames.some((name) => name.includes("withdraw") || name.includes("redeem"))
    )
    || stateVariables.some((name) => name.includes("totalasset") || name.includes("totalshare") || name.includes("reserve"))
  ) {
    return "vault";
  }
  if (methodNames.some((name) => name.includes("swap"))) {
    return "amm";
  }
  return "unknown";
}

function inferAssetRole(assetSymbol: string, actions: SemanticAction[], metadata: AnalysisMetadata): SemanticAsset["role"] {
  const stateVariables = metadata.sourceStateVariables?.map((name) => name.toLowerCase()) ?? [];
  if (actions.some((action) => action.family === "swap" && action.targetAsset === assetSymbol)) {
    return "liquidity";
  }
  if (actions.some((action) => action.family === "deposit-collateral" && action.targetAsset === assetSymbol)) {
    return stateVariables.some((name) => name.includes("share") || name.includes("asset") || name.includes("reserve"))
      ? "liquidity"
      : "collateral";
  }
  if (actions.some((action) => action.family === "borrow" && action.targetAsset === assetSymbol)) {
    return "debt";
  }
  if (Number(metadata.initialReserves?.[assetSymbol] ?? 0) > 0) {
    return "liquidity";
  }
  return "unknown";
}

function inferActionFamily(action: ActionSpec): SemanticAction["family"] {
  const privileged = action.config.privileged === true;
  if (action.method === "deposit" && action.config.depositKind === "liquidity") {
    return "supply-liquidity";
  }
  if (action.method === "deposit") {
    return "deposit-collateral";
  }
  if (action.method === "borrow") {
    return "borrow";
  }
  if (action.method === "repay") {
    return "repay";
  }
  if (action.method === "withdraw") {
    return "withdraw";
  }
  if (action.method === "swap") {
    return "swap";
  }
  if (action.method === "setPrice") {
    return privileged ? "price-update" : "price-update";
  }
  return "unknown";
}

function inferTargetAsset(action: ActionSpec, manifest: ProtocolManifest): string | undefined {
  const configuredAsset = action.config.asset;
  if (typeof configuredAsset === "string" && configuredAsset.length > 0) {
    return configuredAsset;
  }

  const haystack = [action.id, action.label, ...action.effectsHint]
    .join(" ")
    .toLowerCase();

  return manifest.assets.find((asset) => haystack.includes(asset.symbol.toLowerCase()))?.symbol;
}

function analyzeActions(manifest: ProtocolManifest): SemanticAction[] {
  const metadata = getMetadata(manifest);
  return manifest.actions.map((action) => {
    const family = inferActionFamily(action);
    const riskTags: string[] = [];
    const modifiers = metadata.sourceFunctionModifiers?.[action.id] ?? [];
    const visibility = metadata.sourceFunctionVisibility?.[action.id];

    if (family === "borrow") {
      riskTags.push("debt-expansion");
    }
    if (family === "withdraw") {
      riskTags.push("liquidity-drain");
    }
    if (family === "swap") {
      riskTags.push("reserve-balance-shift");
    }
    if (family === "price-update") {
      riskTags.push("oracle-sensitive");
    }
    if (modifiers.length > 0) {
      riskTags.push(`modifiers:${modifiers.join("+")}`);
    }
    if (visibility === "internal" || visibility === "private") {
      riskTags.push("non-public");
    }

    return {
      actionId: action.id,
      family,
      actorRole: action.actorRole,
      targetAsset: inferTargetAsset(action, manifest),
      dependsOnPrice: family === "borrow" || family === "price-update",
      riskTags
    };
  });
}

function analyzeRoles(manifest: ProtocolManifest, actions: SemanticAction[]) {
  const metadata = getMetadata(manifest);
  return manifest.roles.map((role) => {
    const capabilities = actions
      .filter((action) => action.actorRole === role.id)
      .filter((action) => !(role.id.toLowerCase().includes("vault") && action.riskTags.some((tag) => tag.startsWith("modifiers:"))))
      .map((action) => action.family);
    const notes: string[] = [];

    if (role.id.toLowerCase().includes("attacker")) {
      notes.push("adversarial role");
    }
    if (role.id.toLowerCase().includes("oracle")) {
      notes.push("oracle privileged role");
    }
    if (role.id.toLowerCase().includes("liquidity")) {
      notes.push("liquidity provisioning role");
    }
    if (role.id.toLowerCase().includes("vault")) {
      notes.push("vault user role");
    }
    if (role.id.toLowerCase().includes("admin") && metadata.sourceConstructorPresent) {
      notes.push("constructor-aware admin role");
    }
    if (role.id.toLowerCase().includes("vault") && Object.values(metadata.sourceFunctionModifiers ?? {}).some((modifiers) => modifiers.some((modifier) => /owner|admin|oracle/i.test(modifier)))) {
      notes.push("user role filtered away from privileged-only actions");
    }

    return {
      roleId: role.id,
      label: role.description,
      capabilities,
      notes
    };
  });
}

function analyzeAssets(manifest: ProtocolManifest, actions: SemanticAction[], metadata: AnalysisMetadata): SemanticAsset[] {
  return manifest.assets.map((asset) => ({
    symbol: asset.symbol,
    role: inferAssetRole(asset.symbol, actions, metadata),
    priceSource: asset.priceSource,
    priority: Number(metadata.initialReserves?.[asset.symbol] ?? metadata.initialPrices?.[asset.symbol] ?? 0)
  }));
}

function deriveCandidateInvariants(manifest: ProtocolManifest, archetype: SemanticModel["archetype"]): SemanticInvariant[] {
  const metadata = getMetadata(manifest);
  const manifestInvariants: SemanticInvariant[] = manifest.invariants.map((invariant) => ({
    id: invariant.id,
    source: "manifest",
    kind: invariant.kind,
    rationale: invariant.description,
    priority: invariant.severity === "critical" || invariant.severity === "high" ? "high" : "medium"
  }));

  const derived: SemanticInvariant[] = [];

  if (archetype === "lending") {
    derived.push({
      id: `${manifest.id}-derived-collateral-envelope`,
      source: "derived",
      kind: "solvency",
      rationale: "Borrow actions imply per-account collateralization constraints that should be monitored.",
      priority: "high"
    });
    derived.push({
      id: `${manifest.id}-derived-liquidity-drain`,
      source: "derived",
      kind: "profit",
      rationale: "Withdraw actions against shared reserves imply the protocol should detect suspicious reserve extraction.",
      priority: "high"
    });
  }

  if (archetype === "vault") {
    derived.push({
      id: `${manifest.id}-derived-vault-conservation`,
      source: "derived",
      kind: "conservation",
      rationale: "Vault withdraw paths should not permit more underlying to leave than has been deposited.",
      priority: "high"
    });
    derived.push({
      id: `${manifest.id}-derived-vault-profit-bound`,
      source: "derived",
      kind: "profit",
      rationale: "Vault users should not be able to extract abnormal profit through withdraw-like actions without corresponding deposits.",
      priority: "high"
    });
  }

  if (archetype === "amm") {
    derived.push({
      id: `${manifest.id}-derived-amm-conservation`,
      source: "derived",
      kind: "conservation",
      rationale: "AMM swaps should preserve reserve accounting and avoid impossible reserve depletion.",
      priority: "high"
    });
    derived.push({
      id: `${manifest.id}-derived-amm-profit-bound`,
      source: "derived",
      kind: "profit",
      rationale: "Swaps should not create abnormal trader profit without corresponding reserve movement.",
      priority: "medium"
    });
  }

  if ((metadata.sourceConstructorPresent ?? false) && Object.keys(metadata.sourceFunctionModifiers ?? {}).length > 0) {
    derived.push({
      id: `${manifest.id}-derived-access-control`,
      source: "derived",
      kind: "access-control",
      rationale: "Source metadata shows constructor and function modifiers, suggesting privileged actions should be separated from user actions.",
      priority: "medium"
    });
  }

  return [...manifestInvariants, ...derived];
}

export function analyzeProtocolSemantics(manifest: ProtocolManifest): SemanticModel {
  const metadata = getMetadata(manifest);
  const archetype = inferArchetype(manifest);
  const actions = analyzeActions(manifest);
  const roles = analyzeRoles(manifest, actions);
  const assets = analyzeAssets(manifest, actions, metadata);
  const candidateInvariants = deriveCandidateInvariants(manifest, archetype);
  const notes: string[] = [];

  if (actions.some((action) => action.family === "price-update")) {
    notes.push("Protocol behavior is oracle-sensitive.");
  }
  if (actions.some((action) => action.family === "withdraw")) {
    notes.push("Protocol exposes value-extraction paths via withdraw-like actions.");
  }
  if (archetype === "vault") {
    notes.push("Vault-style accounting should preserve depositor value across deposit and withdraw flows.");
  }
  if ((metadata.sourceStateVariables?.length ?? 0) > 0) {
    notes.push(`Source metadata contributed ${metadata.sourceStateVariables?.length ?? 0} state variable hints.`);
  }
  if (Object.keys(metadata.sourceFunctionVisibility ?? {}).length > 0) {
    notes.push(`Source metadata tracked visibility for ${Object.keys(metadata.sourceFunctionVisibility ?? {}).length} functions.`);
  }
  if ((metadata.sourceConstructorPresent ?? false)) {
    notes.push("Source metadata detected a constructor path.");
  }

  return semanticModelSchema.parse({
    protocolId: manifest.id,
    protocolName: manifest.name,
    archetype,
    roles,
    assets,
    actions,
    candidateInvariants,
    notes
  });
}
