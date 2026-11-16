import {
  scenarioSchema,
  type AdvisoryLink,
  type LlmSemanticExtraction,
  type ProtocolManifest,
  type Scenario,
  type SemanticModel
} from "../../shared/src/index.js";

function findActionId(semantics: SemanticModel, family: string): string | undefined {
  return semantics.actions.find((action) => action.family === family)?.actionId;
}

function findActionById(manifest: ProtocolManifest, actionId: string | undefined) {
  return manifest.actions.find((action) => action.id === actionId);
}

function findActorRole(semantics: SemanticModel, family: string): string | undefined {
  return semantics.actions.find((action) => action.family === family)?.actorRole;
}

function selectAsset(semantics: SemanticModel, role: string): string | undefined {
  return semantics.assets.find((asset) => asset.role === role)?.symbol;
}

function sketchConfidenceScore(confidence: LlmSemanticExtraction["attackSketches"][number]["confidence"]): string {
  return `confidence-${confidence}`;
}

function buildBorrowPriceSketch(
  manifest: ProtocolManifest,
  semantics: SemanticModel,
  sketch: LlmSemanticExtraction["attackSketches"][number],
  includeWithdraw: boolean
): Scenario | null {
  const liquidityActionId = findActionId(semantics, "supply-liquidity");
  const borrowActionId = findActionId(semantics, "borrow");
  const collateralActionId = findActionId(semantics, "deposit-collateral");
  const priceActionId = findActionId(semantics, "price-update");
  const withdrawActionId = includeWithdraw ? findActionId(semantics, "withdraw") : undefined;
  const liquidityActor = findActorRole(semantics, "supply-liquidity");
  const borrowerActor = findActorRole(semantics, "borrow") ?? findActorRole(semantics, "deposit-collateral");
  const oracleActor = findActorRole(semantics, "price-update");
  const debtAsset = selectAsset(semantics, "debt") ?? selectAsset(semantics, "liquidity");
  const collateralAsset = selectAsset(semantics, "collateral") ?? debtAsset;

  if (!liquidityActionId || !borrowActionId || !collateralActionId || !priceActionId || !liquidityActor || !borrowerActor || !oracleActor || !debtAsset || !collateralAsset) {
    return null;
  }

  const steps = [
    { actor: liquidityActor, actionId: liquidityActionId, args: { asset: debtAsset, amount: 9000 } },
    { actor: borrowerActor, actionId: collateralActionId, args: { asset: collateralAsset, amount: 9 } },
    { actor: borrowerActor, actionId: borrowActionId, args: { asset: debtAsset, amount: includeWithdraw ? 10000 : 11000 } },
    { actor: oracleActor, actionId: priceActionId, args: { asset: collateralAsset, price: includeWithdraw ? 250 : 300 } }
  ];

  if (includeWithdraw && withdrawActionId) {
    steps.push({ actor: borrowerActor, actionId: withdrawActionId, args: { asset: debtAsset, amount: 14000 } });
  }

  return scenarioSchema.parse({
    id: `${manifest.id}-llm-${sketch.id}`,
    source: "llm",
    goal: "invariant-break",
    assumptions: [`llm-sketch:${sketch.id}`],
    tags: ["llm", semantics.archetype, sketchConfidenceScore(sketch.confidence), ...sketch.targetActions],
    steps
  });
}

function buildReserveDrainSketch(
  manifest: ProtocolManifest,
  semantics: SemanticModel,
  sketch: LlmSemanticExtraction["attackSketches"][number],
  includeBorrow: boolean
): Scenario | null {
  const liquidityActionId = findActionId(semantics, "supply-liquidity");
  const withdrawActionId = findActionId(semantics, "withdraw");
  const borrowActionId = includeBorrow ? findActionId(semantics, "borrow") : undefined;
  const collateralActionId = includeBorrow ? findActionId(semantics, "deposit-collateral") : undefined;
  const liquidityActor = findActorRole(semantics, "supply-liquidity");
  const attackerActor = findActorRole(semantics, "withdraw") ?? findActorRole(semantics, "borrow");
  const debtAsset = selectAsset(semantics, "debt") ?? selectAsset(semantics, "liquidity");
  const collateralAsset = includeBorrow ? selectAsset(semantics, "collateral") ?? debtAsset : undefined;

  if (!liquidityActionId || !withdrawActionId || !liquidityActor || !attackerActor || !debtAsset) {
    return null;
  }

  const steps = [{ actor: liquidityActor, actionId: liquidityActionId, args: { asset: debtAsset, amount: includeBorrow ? 12000 : 10000 } }];

  if (includeBorrow && borrowActionId && collateralActionId && collateralAsset) {
    steps.push(
      { actor: attackerActor, actionId: collateralActionId, args: { asset: collateralAsset, amount: 8 } },
      { actor: attackerActor, actionId: borrowActionId, args: { asset: debtAsset, amount: 9000 } }
    );
  }

  steps.push({ actor: attackerActor, actionId: withdrawActionId, args: { asset: debtAsset, amount: includeBorrow ? 20000 : 22000 } });

  return scenarioSchema.parse({
    id: `${manifest.id}-llm-${sketch.id}`,
    source: "llm",
    goal: "invariant-break",
    assumptions: [`llm-sketch:${sketch.id}`],
    tags: ["llm", semantics.archetype, sketchConfidenceScore(sketch.confidence), ...sketch.targetActions],
    steps
  });
}

function buildVaultWithdrawalSketch(
  manifest: ProtocolManifest,
  semantics: SemanticModel,
  sketch: LlmSemanticExtraction["attackSketches"][number],
  includeSafeRedeem: boolean
): Scenario | null {
  const liquidityActionId = findActionId(semantics, "supply-liquidity");
  const depositActionId = findActionId(semantics, "deposit-collateral");
  const withdrawActionIds = semantics.actions.filter((action) => action.family === "withdraw").map((action) => action.actionId);
  const positionWithdrawId = withdrawActionIds.find((actionId) => findActionById(manifest, actionId)?.config.withdrawKind === "position");
  const drainWithdrawId = withdrawActionIds.find((actionId) => findActionById(manifest, actionId)?.config.withdrawKind !== "position") ?? withdrawActionIds[0];
  const liquidityActor = findActorRole(semantics, "supply-liquidity");
  const vaultUser = findActorRole(semantics, "deposit-collateral") ?? findActorRole(semantics, "withdraw");
  const asset = selectAsset(semantics, "collateral") ?? selectAsset(semantics, "liquidity") ?? selectAsset(semantics, "debt");

  if (!liquidityActionId || !depositActionId || !drainWithdrawId || !liquidityActor || !vaultUser || !asset) {
    return null;
  }

  const steps = [
    { actor: liquidityActor, actionId: liquidityActionId, args: { asset, amount: 10000 } },
    { actor: vaultUser, actionId: depositActionId, args: { asset, amount: 3000 } }
  ];

  if (includeSafeRedeem && positionWithdrawId) {
    steps.push({ actor: vaultUser, actionId: positionWithdrawId, args: { asset, amount: 1500 } });
  }

  steps.push({ actor: vaultUser, actionId: drainWithdrawId, args: { asset, amount: includeSafeRedeem ? 12000 : 9000 } });

  return scenarioSchema.parse({
    id: `${manifest.id}-llm-${sketch.id}`,
    source: "llm",
    goal: "invariant-break",
    assumptions: [`llm-sketch:${sketch.id}`],
    tags: ["llm", semantics.archetype, sketchConfidenceScore(sketch.confidence), ...sketch.targetActions],
    steps
  });
}

function buildAmmSketch(
  manifest: ProtocolManifest,
  semantics: SemanticModel,
  sketch: LlmSemanticExtraction["attackSketches"][number],
  includePriceShock: boolean
): Scenario | null {
  const liquidityActions = manifest.actions.filter((action) => action.method === "deposit" && action.config.depositKind === "liquidity");
  const swapActions = semantics.actions.filter((action) => action.family === "swap");
  const priceActionId = includePriceShock ? findActionId(semantics, "price-update") : undefined;
  const lpActor = liquidityActions[0]?.actorRole;
  const trader = swapActions[0]?.actorRole;
  const oracleActor = includePriceShock ? findActorRole(semantics, "price-update") : undefined;
  const firstLiquidity = liquidityActions[0];
  const secondLiquidity = liquidityActions[1];
  const swapForward = swapActions[0];
  const swapBack = swapActions[1];

  if (!firstLiquidity || !secondLiquidity || !swapForward || !lpActor || !trader) {
    return null;
  }

  const assetA = typeof firstLiquidity.config.asset === "string" ? firstLiquidity.config.asset : manifest.assets[0]?.symbol;
  const assetB = typeof secondLiquidity?.config.asset === "string" ? secondLiquidity.config.asset : manifest.assets[1]?.symbol ?? assetA;
  if (!assetA || !assetB) {
    return null;
  }

  const steps: Array<{ actor: string; actionId: string; args: Record<string, unknown> }> = [
    { actor: lpActor, actionId: firstLiquidity.id, args: { asset: assetA, amount: 10000 } },
    { actor: lpActor, actionId: secondLiquidity.id, args: { asset: assetB, amount: 20 } },
    { actor: trader, actionId: swapForward.actionId, args: { assetIn: assetA, assetOut: assetB, amount: 3000 } }
  ];

  if (swapBack) {
    steps.push({ actor: trader, actionId: swapBack.actionId, args: { assetIn: assetB, assetOut: assetA, amount: 10 } });
  }

  if (includePriceShock && priceActionId && oracleActor) {
    steps.push({ actor: oracleActor, actionId: priceActionId, args: { asset: assetB, price: 1000 } });
  }

  return scenarioSchema.parse({
    id: `${manifest.id}-llm-${sketch.id}`,
    source: "llm",
    goal: "invariant-break",
    assumptions: [`llm-sketch:${sketch.id}`],
    tags: ["llm", semantics.archetype, sketchConfidenceScore(sketch.confidence), ...sketch.targetActions],
    steps
  });
}

export function buildLlmSeedScenarios(
  manifest: ProtocolManifest,
  semantics: SemanticModel,
  advisory: LlmSemanticExtraction | null
): Scenario[] {
  if (!advisory) {
    return [];
  }

  const scenarios: Scenario[] = [];

  for (const sketch of advisory.attackSketches) {
    const targets = new Set(sketch.targetActions);
    const mentionsBorrow = targets.has("borrow") || sketch.steps.some((step) => step.toLowerCase().includes("borrow"));
    const mentionsPriceUpdate = targets.has("price-update") || sketch.steps.some((step) => step.toLowerCase().includes("price"));
    const mentionsWithdraw = targets.has("withdraw") || sketch.steps.some((step) => step.toLowerCase().includes("withdraw"));
    const mentionsRedeem = sketch.steps.some((step) => step.toLowerCase().includes("redeem")) || sketch.targetActions.some((action) => action.includes("redeem"));
    const mentionsSwap = targets.has("swap") || sketch.steps.some((step) => step.toLowerCase().includes("swap"));

    if (semantics.archetype === "vault" && mentionsWithdraw) {
      const scenario = buildVaultWithdrawalSketch(manifest, semantics, sketch, mentionsRedeem);
      if (scenario) {
        scenarios.push(scenario);
      }
      continue;
    }

    if (semantics.archetype === "amm" && mentionsSwap) {
      const scenario = buildAmmSketch(manifest, semantics, sketch, mentionsPriceUpdate);
      if (scenario) {
        scenarios.push(scenario);
      }
      continue;
    }

    if (mentionsBorrow && mentionsPriceUpdate) {
      const scenario = buildBorrowPriceSketch(manifest, semantics, sketch, mentionsWithdraw);
      if (scenario) {
        scenarios.push(scenario);
      }
      continue;
    }

    if (mentionsWithdraw) {
      const scenario = buildReserveDrainSketch(manifest, semantics, sketch, mentionsBorrow);
      if (scenario) {
        scenarios.push(scenario);
      }
    }
  }

  return scenarios;
}

export function buildAdvisoryLinks(
  scenarios: Scenario[],
  advisory: LlmSemanticExtraction | null
): AdvisoryLink[] {
  if (!advisory) {
    return [];
  }

  const links: AdvisoryLink[] = [];

  for (const scenario of scenarios) {
    const sketchId = scenario.assumptions.find((entry) => entry.startsWith("llm-sketch:"))?.slice("llm-sketch:".length);
    if (!sketchId) {
      continue;
    }

    const sketch = advisory.attackSketches.find((candidate) => candidate.id === sketchId);
    if (!sketch) {
      continue;
    }

    links.push({
      scenarioId: scenario.id,
      advisoryAttackSketchId: sketch.id,
      advisoryAttackSketchTitle: `${sketch.title} (${sketch.confidence})`,
      targetActions: sketch.targetActions
    });
  }

  return links;
}
