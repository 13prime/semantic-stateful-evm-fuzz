import {
  scenarioSchema,
  type CampaignConfig,
  type ProtocolManifest,
  type Scenario,
  type ScenarioCatalogEntry,
  type ScenarioStep,
  type SemanticAction,
  type SemanticModel
} from "../../shared/src/index.js";
import { analyzeProtocolSemantics } from "./semantic-analysis.js";

interface GeneratorMetadata {
  initialReserves?: Record<string, number>;
  initialPrices?: Record<string, number>;
  collateralFactor?: number;
  seedScenarios?: unknown[];
  sourceFunctionModifiers?: Record<string, string[]>;
}

function getMetadata(manifest: ProtocolManifest): GeneratorMetadata {
  return manifest.metadata as GeneratorMetadata;
}

function numberArg(step: ScenarioStep, key: "amount" | "price"): number | null {
  const value = Number(step.args[key] ?? NaN);
  return Number.isFinite(value) ? value : null;
}

function withAdjustedNumericArg(
  scenario: Scenario,
  matcher: (step: ScenarioStep) => boolean,
  key: "amount" | "price",
  multiplier: number,
  suffix: string
): Scenario | null {
  let changed = false;
  const steps = scenario.steps.map((step) => {
    if (!matcher(step)) {
      return step;
    }

    const original = numberArg(step, key);
    if (original === null || original <= 0) {
      return step;
    }

    changed = true;
    return {
      ...step,
      args: {
        ...step.args,
        [key]: Math.max(1, Math.round(original * multiplier))
      }
    };
  });

  if (!changed) {
    return null;
  }

  return scenarioSchema.parse({
    ...scenario,
    id: `${scenario.id}-${suffix}`,
    source: "mutation",
    steps,
    tags: [...scenario.tags, "mutation", suffix]
  });
}

function findSemanticAction(semantics: SemanticModel, family: SemanticAction["family"]): SemanticAction | undefined {
  return semantics.actions.find((action) => action.family === family);
}

function findPriorityAsset(
  semantics: SemanticModel,
  role: SemanticModel["assets"][number]["role"],
  fallbackSymbol?: string
): string | undefined {
  const match = semantics.assets
    .filter((asset) => asset.role === role)
    .sort((left, right) => right.priority - left.priority)[0];

  return match?.symbol ?? fallbackSymbol;
}

function roleBalance(manifest: ProtocolManifest, roleId: string, asset: string): number {
  const role = manifest.roles.find((entry) => entry.id === roleId);
  return Number(role?.initialBalances[asset] ?? 0);
}

function findRoleId(manifest: ProtocolManifest, matcher: (roleId: string) => boolean): string | undefined {
  return manifest.roles.find((role) => matcher(role.id))?.id;
}

function makeStep(actor: string, actionId: string, args: Record<string, unknown>): ScenarioStep {
  return { actor, actionId, args };
}

function extractOriginId(scenario: Scenario): string | undefined {
  return scenario.assumptions.find((entry) => entry.startsWith("origin:"))?.slice("origin:".length);
}

function isPrivilegedAction(actionId: string, metadata: GeneratorMetadata): boolean {
  const direct = metadata.sourceFunctionModifiers?.[actionId] ?? [];
  const normalizedCandidates = Object.entries(metadata.sourceFunctionModifiers ?? {}).filter(([name]) => {
    const normalizedName = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const normalizedAction = actionId.toLowerCase().replace(/[^a-z0-9]+/g, "");
    return normalizedName === normalizedAction || normalizedName === normalizedAction.replace(/-/g, "");
  });
  const derived = normalizedCandidates.flatMap(([, modifiers]) => modifiers);
  return [...direct, ...derived].some((modifier) => /owner|admin|oracle|guardian|operator/i.test(modifier));
}

function buildSmokeScenario(manifest: ProtocolManifest, config: CampaignConfig): Scenario[] {
  return [
    scenarioSchema.parse({
      id: `${manifest.id}-smoke`,
      source: "template",
      goal: "invariant-break",
      steps: manifest.actions.slice(0, Math.min(manifest.actions.length, config.maxSequenceLength)).map((action) => ({
        actor: action.actorRole,
        actionId: action.id,
        args: {}
      })),
      tags: ["smoke"]
    })
  ];
}

function buildLendingScenarios(manifest: ProtocolManifest, semantics: SemanticModel, metadata: GeneratorMetadata): Scenario[] {
  const semanticLiquidity = findSemanticAction(semantics, "supply-liquidity");
  const semanticCollateral = findSemanticAction(semantics, "deposit-collateral");
  const semanticBorrow = findSemanticAction(semantics, "borrow");
  const semanticPrice = findSemanticAction(semantics, "price-update");
  const semanticWithdraw = findSemanticAction(semantics, "withdraw");

  const rawLiquidity = manifest.actions.find((action) => action.config.depositKind === "liquidity" && action.method === "deposit");
  const rawCollateral = manifest.actions.find((action) => action.config.depositKind === "collateral" && action.method === "deposit")
    ?? manifest.actions.find((action) => action.method === "deposit");
  const rawBorrow = manifest.actions.find((action) => action.method === "borrow");
  const rawPrice = manifest.actions.find((action) => action.method === "setPrice");
  const rawWithdraw = manifest.actions.find((action) => action.method === "withdraw" && action.config.withdrawKind !== "position")
    ?? manifest.actions.find((action) => action.method === "withdraw");

  const liquidityActionId = semanticLiquidity?.actionId ?? rawLiquidity?.id ?? rawCollateral?.id;
  const collateralActionId = semanticCollateral?.actionId ?? rawCollateral?.id;
  const borrowActionId = semanticBorrow?.actionId ?? rawBorrow?.id;
  const priceActionId = semanticPrice?.actionId ?? rawPrice?.id;
  const withdrawActionId = semanticWithdraw?.actionId ?? rawWithdraw?.id;

  const liquidityAsset = semanticLiquidity?.targetAsset
    ?? (typeof rawLiquidity?.config.asset === "string" ? rawLiquidity.config.asset : undefined)
    ?? (typeof rawBorrow?.config.asset === "string" ? rawBorrow.config.asset : undefined)
    ?? findPriorityAsset(semantics, "liquidity")
    ?? findPriorityAsset(semantics, "debt")
    ?? manifest.assets[0]?.symbol;
  const collateralAsset = semanticCollateral?.targetAsset
    ?? (typeof rawCollateral?.config.asset === "string" ? rawCollateral.config.asset : undefined)
    ?? findPriorityAsset(semantics, "collateral", liquidityAsset)
    ?? liquidityAsset;

  const liquidityActor = semanticLiquidity?.actorRole
    ?? rawLiquidity?.actorRole
    ?? findRoleId(manifest, (roleId) => roleId.toLowerCase().includes("liquidity"))
    ?? findRoleId(manifest, (roleId) => roleId.toLowerCase().includes("admin"));
  const attackerActor = semanticBorrow?.actorRole
    ?? rawBorrow?.actorRole
    ?? semanticCollateral?.actorRole
    ?? rawCollateral?.actorRole
    ?? semanticWithdraw?.actorRole
    ?? rawWithdraw?.actorRole
    ?? findRoleId(manifest, (roleId) => roleId.toLowerCase().includes("attacker") || roleId.toLowerCase().includes("user"));
  const oracleActor = semanticPrice?.actorRole
    ?? rawPrice?.actorRole
    ?? findRoleId(manifest, (roleId) => roleId.toLowerCase().includes("oracle") || roleId.toLowerCase().includes("admin"));

  if (!liquidityActionId || !collateralActionId || !borrowActionId || !liquidityAsset || !collateralAsset || !liquidityActor || !attackerActor) {
    return [];
  }

  const initialReserve = Number(metadata.initialReserves?.[liquidityAsset] ?? 0);
  const collateralPrice = Number(metadata.initialPrices?.[collateralAsset] ?? 1);
  const collateralFactor = Number(metadata.collateralFactor ?? 0.8);
  const liquidityBalance = roleBalance(manifest, liquidityActor, liquidityAsset);
  const collateralBalance = roleBalance(manifest, attackerActor, collateralAsset);

  const liquidityAmount = Math.max(
    1,
    Math.min(Math.round(liquidityBalance * 0.2), Math.round(initialReserve * 0.5) || liquidityBalance)
  );
  const collateralAmount = Math.max(1, Math.round(collateralBalance * 0.05));
  const maxBorrow = collateralAmount * collateralPrice * collateralFactor;
  const healthyBorrowAmount = Math.max(1, Math.round(Math.min(initialReserve + liquidityAmount, maxBorrow * 0.33)));
  const riskyBorrowAmount = Math.max(1, Math.round(Math.min(initialReserve + liquidityAmount, maxBorrow * 0.95)));
  const crashPrice = Math.max(1, Math.round(collateralPrice * 0.2));
  const drainAmount = Math.max(1, Math.round(initialReserve + liquidityAmount / 2));

  const scenarios: Scenario[] = [
    scenarioSchema.parse({
      id: `${manifest.id}-generated-healthy-borrow`,
      source: "template",
      goal: "profit",
      steps: [
        makeStep(liquidityActor, liquidityActionId, { asset: liquidityAsset, amount: liquidityAmount }),
        makeStep(attackerActor, collateralActionId, { asset: collateralAsset, amount: collateralAmount }),
        makeStep(attackerActor, borrowActionId, { asset: liquidityAsset, amount: healthyBorrowAmount })
      ],
      tags: ["generated", semantics.archetype, "baseline"]
    })
  ];

  if (priceActionId && oracleActor && !isPrivilegedAction(priceActionId, metadata)) {
    scenarios.push(
      scenarioSchema.parse({
        id: `${manifest.id}-generated-oracle-crash`,
        source: "template",
        goal: "invariant-break",
        steps: [
          makeStep(liquidityActor, liquidityActionId, { asset: liquidityAsset, amount: liquidityAmount }),
          makeStep(attackerActor, collateralActionId, { asset: collateralAsset, amount: collateralAmount }),
          makeStep(attackerActor, borrowActionId, { asset: liquidityAsset, amount: riskyBorrowAmount }),
          makeStep(oracleActor, priceActionId, { asset: collateralAsset, price: crashPrice })
        ],
        tags: ["generated", semantics.archetype, "oracle-manipulation", "bad-debt"]
      })
    );
  }

  if (withdrawActionId && !isPrivilegedAction(withdrawActionId, metadata)) {
    scenarios.push(
      scenarioSchema.parse({
        id: `${manifest.id}-generated-reserve-drain`,
        source: "template",
        goal: "invariant-break",
        steps: [
          makeStep(liquidityActor, liquidityActionId, { asset: liquidityAsset, amount: liquidityAmount }),
          makeStep(attackerActor, withdrawActionId, { asset: liquidityAsset, amount: drainAmount })
        ],
        tags: ["generated", semantics.archetype, "drain"]
      })
    );
  }

  return scenarios;
}

function buildVaultScenarios(manifest: ProtocolManifest, semantics: SemanticModel, metadata: GeneratorMetadata): Scenario[] {
  const liquidityAction = manifest.actions.find((action) => action.method === "deposit" && action.config.depositKind === "liquidity")
    ?? manifest.actions.find((action) => action.method === "deposit");
  const userDepositAction = manifest.actions.find((action) => action.method === "deposit" && action.config.depositKind !== "liquidity")
    ?? manifest.actions.find((action) => action.method === "deposit");
  const safeWithdrawAction = manifest.actions.find((action) => action.method === "withdraw" && action.config.withdrawKind === "position")
    ?? manifest.actions.find((action) => action.method === "withdraw" && !isPrivilegedAction(action.id, metadata));
  const unsafeWithdrawAction = manifest.actions.find((action) => action.method === "withdraw" && action.config.withdrawKind === "drain" && !isPrivilegedAction(action.id, metadata))
    ?? manifest.actions.find((action) => action.method === "withdraw" && action.config.withdrawKind !== "position" && !isPrivilegedAction(action.id, metadata));
  const privilegedWithdrawAction = manifest.actions.find((action) => action.method === "withdraw" && isPrivilegedAction(action.id, metadata));
  const privilegedPriceAction = manifest.actions.find((action) => action.method === "setPrice" && isPrivilegedAction(action.id, metadata));

  const underlyingAsset = typeof liquidityAction?.config.asset === "string"
    ? liquidityAction.config.asset
    : typeof userDepositAction?.config.asset === "string"
      ? userDepositAction.config.asset
      : manifest.assets[0]?.symbol;
  const liquidityActor = liquidityAction?.actorRole
    ?? findRoleId(manifest, (roleId) => roleId.toLowerCase().includes("liquidity"))
    ?? findRoleId(manifest, (roleId) => roleId.toLowerCase().includes("admin"));
  const vaultUser = userDepositAction?.actorRole
    ?? safeWithdrawAction?.actorRole
    ?? unsafeWithdrawAction?.actorRole
    ?? findRoleId(manifest, (roleId) => roleId.toLowerCase().includes("vault") || roleId.toLowerCase().includes("user"));
  const adminActor = privilegedWithdrawAction?.actorRole
    ?? privilegedPriceAction?.actorRole
    ?? findRoleId(manifest, (roleId) => roleId.toLowerCase().includes("admin") || roleId.toLowerCase().includes("oracle"));

  if (!liquidityAction || !userDepositAction || !underlyingAsset || !liquidityActor || !vaultUser) {
    return [];
  }

  const initialReserve = Number(metadata.initialReserves?.[underlyingAsset] ?? 0);
  const lpBalance = roleBalance(manifest, liquidityActor, underlyingAsset);
  const userBalance = roleBalance(manifest, vaultUser, underlyingAsset);

  const seedAmount = Math.max(1, Math.min(Math.round(lpBalance * 0.2), Math.round(initialReserve * 0.5) || lpBalance));
  const depositAmount = Math.max(1, Math.round(userBalance * 0.2));
  const redeemAmount = Math.max(1, Math.round(depositAmount * 0.5));
  const exploitWithdrawAmount = Math.max(1, Math.round(initialReserve + seedAmount / 2));
  const privilegedWithdrawAmount = Math.max(1, Math.round(initialReserve + 1));

  const scenarios: Scenario[] = [];

  if (safeWithdrawAction) {
    scenarios.push(
      scenarioSchema.parse({
        id: `${manifest.id}-generated-vault-redeem`,
        source: "template",
        goal: "profit",
        steps: [
          makeStep(liquidityActor, liquidityAction.id, { asset: underlyingAsset, amount: seedAmount }),
          makeStep(vaultUser, userDepositAction.id, { asset: underlyingAsset, amount: depositAmount }),
          makeStep(vaultUser, safeWithdrawAction.id, { asset: underlyingAsset, amount: redeemAmount })
        ],
        tags: ["generated", semantics.archetype, "baseline"]
      })
    );
  }

  if (unsafeWithdrawAction) {
    scenarios.push(
      scenarioSchema.parse({
        id: `${manifest.id}-generated-vault-drain`,
        source: "template",
        goal: "invariant-break",
        steps: [
          makeStep(liquidityActor, liquidityAction.id, { asset: underlyingAsset, amount: seedAmount }),
          makeStep(vaultUser, userDepositAction.id, { asset: underlyingAsset, amount: depositAmount }),
          makeStep(vaultUser, unsafeWithdrawAction.id, { asset: underlyingAsset, amount: exploitWithdrawAmount })
        ],
        tags: ["generated", semantics.archetype, "drain"]
      })
    );
  }

  if (privilegedWithdrawAction && adminActor) {
    scenarios.push(
      scenarioSchema.parse({
        id: `${manifest.id}-generated-admin-withdraw`,
        source: "template",
        goal: "invariant-break",
        steps: [
          makeStep(liquidityActor, liquidityAction.id, { asset: underlyingAsset, amount: seedAmount }),
          makeStep(vaultUser, userDepositAction.id, { asset: underlyingAsset, amount: depositAmount }),
          makeStep(adminActor, privilegedWithdrawAction.id, { asset: underlyingAsset, amount: privilegedWithdrawAmount })
        ],
        tags: ["generated", semantics.archetype, "privileged", "admin-withdraw"]
      })
    );
  }

  return scenarios;
}

function buildAmmScenarios(manifest: ProtocolManifest, metadata: GeneratorMetadata): Scenario[] {
  const deposits = manifest.actions.filter((action) => action.method === "deposit" && action.config.depositKind === "liquidity");
  const swaps = manifest.actions.filter((action) => action.method === "swap");
  const priceAction = manifest.actions.find((action) => action.method === "setPrice");

  if (deposits.length < 2 || swaps.length === 0) {
    return [];
  }

  const [firstDeposit, secondDeposit] = deposits;
  const traderRole = swaps[0]?.actorRole ?? findRoleId(manifest, (roleId) => roleId.toLowerCase().includes("trader") || roleId.toLowerCase().includes("user"));
  const lpRole = firstDeposit.actorRole;
  const assetA = typeof firstDeposit.config.asset === "string" ? firstDeposit.config.asset : manifest.assets[0]?.symbol;
  const assetB = typeof secondDeposit.config.asset === "string" ? secondDeposit.config.asset : manifest.assets[1]?.symbol ?? assetA;

  if (!traderRole || !lpRole || !assetA || !assetB) {
    return [];
  }

  const scenarios: Scenario[] = [
    scenarioSchema.parse({
      id: `${manifest.id}-generated-amm-swap-roundtrip`,
      source: "template",
      goal: "profit",
      steps: [
        makeStep(lpRole, firstDeposit.id, { asset: assetA, amount: 10000 }),
        makeStep(lpRole, secondDeposit.id, { asset: assetB, amount: 20 }),
        makeStep(traderRole, swaps[0].id, { assetIn: assetA, assetOut: assetB, amount: 2000 })
      ],
      tags: ["generated", "amm", "baseline"]
    })
  ];

  if (swaps[1]) {
    scenarios.push(
      scenarioSchema.parse({
        id: `${manifest.id}-generated-amm-reserve-shift`,
        source: "template",
        goal: "invariant-break",
        steps: [
          makeStep(lpRole, firstDeposit.id, { asset: assetA, amount: 10000 }),
          makeStep(lpRole, secondDeposit.id, { asset: assetB, amount: 20 }),
          makeStep(traderRole, swaps[0].id, { assetIn: assetA, assetOut: assetB, amount: 4000 }),
          makeStep(traderRole, swaps[1].id, { assetIn: assetB, assetOut: assetA, amount: 10 })
        ],
        tags: ["generated", "amm", "reserve-shift"]
      })
    );
  }

  if (priceAction) {
    scenarios.push(
      scenarioSchema.parse({
        id: `${manifest.id}-generated-amm-price-shock`,
        source: "template",
        goal: "invariant-break",
        steps: [
          makeStep(lpRole, firstDeposit.id, { asset: assetA, amount: 10000 }),
          makeStep(lpRole, secondDeposit.id, { asset: assetB, amount: 20 }),
          makeStep(traderRole, swaps[0].id, { assetIn: assetA, assetOut: assetB, amount: 3000 }),
          makeStep(priceAction.actorRole, priceAction.id, { asset: assetB, price: 1000 })
        ],
        tags: ["generated", "amm", "price-shock"]
      })
    );
  }

  return scenarios;
}

function buildGeneratedScenarios(manifest: ProtocolManifest): Scenario[] {
  const semantics = analyzeProtocolSemantics(manifest);
  const metadata = getMetadata(manifest);

  if (semantics.archetype === "lending") {
    return buildLendingScenarios(manifest, semantics, metadata);
  }

  if (semantics.archetype === "vault") {
    return buildVaultScenarios(manifest, semantics, metadata);
  }

  if (semantics.archetype === "amm") {
    return buildAmmScenarios(manifest, metadata);
  }

  return [];
}

function buildMutationScenarios(seedScenarios: Scenario[], manifest: ProtocolManifest): Scenario[] {
  const semantics = analyzeProtocolSemantics(manifest);
  const borrowActionIds = new Set(
    semantics.actions.filter((action) => action.family === "borrow").map((action) => action.actionId)
  );
  const withdrawActionIds = new Set(
    semantics.actions.filter((action) => action.family === "withdraw").map((action) => action.actionId)
  );
  const priceActionIds = new Set(
    semantics.actions.filter((action) => action.family === "price-update").map((action) => action.actionId)
  );
  const swapActionIds = new Set(
    semantics.actions.filter((action) => action.family === "swap").map((action) => action.actionId)
  );

  const mutations: Scenario[] = [];

  for (const scenario of seedScenarios) {
    const borrowAmplified = withAdjustedNumericArg(
      scenario,
      (step) => borrowActionIds.has(step.actionId),
      "amount",
      1.25,
      "borrow-plus-25"
    );
    if (borrowAmplified) {
      mutations.push(borrowAmplified);
    }

    const borrowReduced = withAdjustedNumericArg(
      scenario,
      (step) => borrowActionIds.has(step.actionId),
      "amount",
      0.5,
      "borrow-half"
    );
    if (borrowReduced) {
      mutations.push(borrowReduced);
    }

    const drainAmplified = withAdjustedNumericArg(
      scenario,
      (step) => withdrawActionIds.has(step.actionId) || swapActionIds.has(step.actionId),
      "amount",
      1.25,
      "withdraw-plus-25"
    );
    if (drainAmplified) {
      mutations.push(drainAmplified);
    }

    const deeperCrash = withAdjustedNumericArg(
      scenario,
      (step) => priceActionIds.has(step.actionId),
      "price",
      0.5,
      "price-half"
    );
    if (deeperCrash) {
      mutations.push(deeperCrash);
    }
  }

  return mutations;
}

function scenarioSignature(scenario: Scenario): string {
  return JSON.stringify(scenario.steps);
}

export function buildSeedScenarios(manifest: ProtocolManifest, config: CampaignConfig): Scenario[] {
  const metadata = getMetadata(manifest);
  const inlineScenarios = Array.isArray(metadata.seedScenarios)
    ? metadata.seedScenarios.map((scenario) => scenarioSchema.parse(scenario))
    : [];
  const generatedScenarios = buildGeneratedScenarios(manifest);
  const initialScenarios = [...inlineScenarios, ...generatedScenarios];
  const scenariosToMutate = initialScenarios.length > 0 ? initialScenarios : buildSmokeScenario(manifest, config);
  const mutationScenarios = buildMutationScenarios(scenariosToMutate, manifest);

  const uniqueScenarios = new Map<string, Scenario>();
  for (const scenario of [...scenariosToMutate, ...mutationScenarios]) {
    const signature = scenarioSignature(scenario);
    if (!uniqueScenarios.has(signature)) {
      uniqueScenarios.set(signature, scenario);
    }
  }

  const scenarios = Array.from(uniqueScenarios.values());
  return scenarios.slice(0, config.maxIterations);
}

export function buildScenarioCatalog(scenarios: Scenario[]): ScenarioCatalogEntry[] {
  return scenarios.map((scenario) => ({
    id: scenario.id,
    source: scenario.source,
    goal: scenario.goal,
    stepCount: scenario.steps.length,
    tags: scenario.tags,
    originId: extractOriginId(scenario)
  }));
}

export function findScenarioById(scenarios: Scenario[], scenarioId: string): Scenario | undefined {
  return scenarios.find((scenario) => scenario.id === scenarioId);
}
