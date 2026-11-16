import type {
  ActionSpec,
  CampaignConfig,
  ExecutionResult,
  InvariantFinding,
  ProtocolManifest,
  Scenario,
  ScenarioStep,
  SemanticModel
} from "../../shared/src/index.js";
import { analyzeProtocolSemantics } from "../../protocols/src/semantic-analysis.js";

interface HarnessState {
  balances: Record<string, Record<string, number>>;
  depositedCollateral: Record<string, Record<string, number>>;
  suppliedLiquidity: Record<string, Record<string, number>>;
  debts: Record<string, Record<string, number>>;
  collateralFactor: number;
  prices: Record<string, number>;
  poolReserves: Record<string, number>;
  events: string[];
}

interface HarnessMetadata {
  initialReserves?: Record<string, number>;
  initialPrices?: Record<string, number>;
  collateralFactor?: number;
  profitAlertThreshold?: number;
  protocolLossAlertThreshold?: number;
}

function getHarnessMetadata(manifest: ProtocolManifest): HarnessMetadata {
  return manifest.metadata as HarnessMetadata;
}

function createInitialState(manifest: ProtocolManifest): HarnessState {
  const metadata = getHarnessMetadata(manifest);
  const balances: HarnessState["balances"] = {};
  const depositedCollateral: HarnessState["depositedCollateral"] = {};
  const suppliedLiquidity: HarnessState["suppliedLiquidity"] = {};
  const debts: HarnessState["debts"] = {};
  const poolReserves: HarnessState["poolReserves"] = {};
  const prices: HarnessState["prices"] = {};

  for (const role of manifest.roles) {
    balances[role.id] = {};
    depositedCollateral[role.id] = {};
    suppliedLiquidity[role.id] = {};
    debts[role.id] = {};

    for (const asset of manifest.assets) {
      const initialValue = role.initialBalances[asset.symbol];
      balances[role.id][asset.symbol] = initialValue ? Number(initialValue) : 0;
      depositedCollateral[role.id][asset.symbol] = 0;
      suppliedLiquidity[role.id][asset.symbol] = 0;
      debts[role.id][asset.symbol] = 0;
    }
  }

  for (const asset of manifest.assets) {
    const reserve = Number(metadata.initialReserves?.[asset.symbol] ?? 0);
    const price = Number(metadata.initialPrices?.[asset.symbol] ?? 1);
    poolReserves[asset.symbol] = reserve;
    prices[asset.symbol] = price;
  }

  return {
    balances,
    depositedCollateral,
    suppliedLiquidity,
    debts,
    collateralFactor: Number(metadata.collateralFactor ?? 0.8),
    prices,
    poolReserves,
    events: []
  };
}

function getAction(manifest: ProtocolManifest, actionId: string): ActionSpec {
  const action = manifest.actions.find((entry) => entry.id === actionId);
  if (!action) {
    throw new Error(`Unknown action: ${actionId}`);
  }

  return action;
}

function getAssetAmount(step: ScenarioStep): { asset: string; amount: number } {
  const asset = String(step.args.asset ?? "");
  const amount = Number(step.args.amount ?? 0);

  if (!asset || Number.isNaN(amount) || amount <= 0) {
    throw new Error(`Invalid asset/amount for action ${step.actionId}`);
  }

  return { asset, amount };
}

function collateralValue(state: HarnessState, actor: string): number {
  return Object.entries(state.depositedCollateral[actor] ?? {}).reduce((sum, [asset, amount]) => {
    return sum + amount * (state.prices[asset] ?? 0);
  }, 0);
}

function suppliedLiquidityValue(state: HarnessState, actor: string): number {
  return Object.entries(state.suppliedLiquidity[actor] ?? {}).reduce((sum, [asset, amount]) => {
    return sum + amount * (state.prices[asset] ?? 0);
  }, 0);
}

function walletValue(state: HarnessState, actor: string): number {
  return Object.entries(state.balances[actor] ?? {}).reduce((sum, [asset, amount]) => {
    return sum + amount * (state.prices[asset] ?? 0);
  }, 0);
}

function debtValue(state: HarnessState, actor: string): number {
  return Object.entries(state.debts[actor] ?? {}).reduce((sum, [asset, amount]) => {
    return sum + amount * (state.prices[asset] ?? 0);
  }, 0);
}

function totalDebtForAsset(state: HarnessState, assetSymbol: string): number {
  return Object.values(state.debts).reduce((sum, actorDebts) => sum + (actorDebts[assetSymbol] ?? 0), 0);
}

function totalHeldByProtocolForAsset(state: HarnessState, assetSymbol: string): number {
  return Object.values(state.depositedCollateral).reduce((sum, actorCollateral) => sum + (actorCollateral[assetSymbol] ?? 0), 0)
    + Object.values(state.suppliedLiquidity).reduce((sum, actorLiquidity) => sum + (actorLiquidity[assetSymbol] ?? 0), 0);
}

function applyAction(state: HarnessState, manifest: ProtocolManifest, step: ScenarioStep): string[] {
  const action = getAction(manifest, step.actionId);
  const notes: string[] = [];

  switch (action.method) {
    case "deposit": {
      const { asset, amount } = getAssetAmount(step);
      const depositKind = String(action.config.depositKind ?? "collateral");
      if ((state.balances[step.actor]?.[asset] ?? 0) < amount) {
        throw new Error(`${step.actor} lacks ${asset} for deposit`);
      }

      state.balances[step.actor][asset] -= amount;
      state.poolReserves[asset] += amount;

      if (depositKind === "liquidity") {
        state.suppliedLiquidity[step.actor][asset] += amount;
        notes.push(`${step.actor} supplied ${amount} ${asset} as pool liquidity`);
      } else {
        state.depositedCollateral[step.actor][asset] += amount;
        notes.push(`${step.actor} deposited ${amount} ${asset} as collateral`);
      }
      break;
    }
    case "borrow": {
      const { asset, amount } = getAssetAmount(step);
      const nextDebtValue = debtValue(state, step.actor) + amount * (state.prices[asset] ?? 0);
      const maxBorrow = collateralValue(state, step.actor) * state.collateralFactor;
      if (nextDebtValue > maxBorrow) {
        throw new Error(`${step.actor} exceeds collateral factor when borrowing ${asset}`);
      }
      if ((state.poolReserves[asset] ?? 0) < amount) {
        throw new Error(`pool lacks ${asset} liquidity`);
      }
      state.poolReserves[asset] -= amount;
      state.balances[step.actor][asset] += amount;
      state.debts[step.actor][asset] += amount;
      notes.push(`${step.actor} borrowed ${amount} ${asset}`);
      break;
    }
    case "repay": {
      const { asset, amount } = getAssetAmount(step);
      if ((state.balances[step.actor]?.[asset] ?? 0) < amount) {
        throw new Error(`${step.actor} lacks ${asset} for repay`);
      }
      const repayAmount = Math.min(amount, state.debts[step.actor][asset] ?? 0);
      state.balances[step.actor][asset] -= repayAmount;
      state.poolReserves[asset] += repayAmount;
      state.debts[step.actor][asset] -= repayAmount;
      notes.push(`${step.actor} repaid ${repayAmount} ${asset}`);
      break;
    }
    case "withdraw": {
      const { asset, amount } = getAssetAmount(step);
      if ((state.poolReserves[asset] ?? 0) < amount) {
        throw new Error(`pool lacks ${asset} reserves for withdrawal`);
      }
      state.poolReserves[asset] -= amount;
      state.balances[step.actor][asset] += amount;
      notes.push(`${step.actor} withdrew ${amount} ${asset}`);
      break;
    }
    case "swap": {
      const assetIn = String(step.args.assetIn ?? "");
      const assetOut = String(step.args.assetOut ?? "");
      const amount = Number(step.args.amount ?? 0);
      if (!assetIn || !assetOut || Number.isNaN(amount) || amount <= 0) {
        throw new Error(`Invalid swap arguments for ${step.actionId}`);
      }
      if ((state.balances[step.actor]?.[assetIn] ?? 0) < amount) {
        throw new Error(`${step.actor} lacks ${assetIn} for swap`);
      }
      const priceIn = state.prices[assetIn] ?? 1;
      const priceOut = state.prices[assetOut] ?? 1;
      const grossOut = Math.max(1, Math.round((amount * priceIn) / priceOut));
      if ((state.poolReserves[assetOut] ?? 0) < grossOut) {
        throw new Error(`pool lacks ${assetOut} liquidity for swap`);
      }
      state.balances[step.actor][assetIn] -= amount;
      state.poolReserves[assetIn] += amount;
      state.poolReserves[assetOut] -= grossOut;
      state.balances[step.actor][assetOut] += grossOut;
      notes.push(`${step.actor} swapped ${amount} ${assetIn} for ${grossOut} ${assetOut}`);
      break;
    }
    case "setPrice": {
      const asset = String(step.args.asset ?? "");
      const price = Number(step.args.price ?? 0);
      if (!asset || Number.isNaN(price) || price <= 0) {
        throw new Error(`Invalid oracle update for ${step.actionId}`);
      }
      state.prices[asset] = price;
      notes.push(`oracle updated ${asset} price to ${price}`);
      break;
    }
    default:
      throw new Error(`Unsupported harness method: ${action.method}`);
  }

  state.events.push(...notes);
  return notes;
}

function computeProfitDeltaNumbers(manifest: ProtocolManifest, state: HarnessState): Record<string, number> {
  const result: Record<string, number> = {};

  for (const role of manifest.roles) {
    const netWorth = walletValue(state, role.id) + collateralValue(state, role.id) + suppliedLiquidityValue(state, role.id) - debtValue(state, role.id);
    const initialWorth = Object.entries(role.initialBalances).reduce((sum, [asset, amount]) => {
      return sum + Number(amount) * (state.prices[asset] ?? 1);
    }, 0);
    result[role.id] = netWorth - initialWorth;
  }

  return result;
}

function formatNumericRecord(values: Record<string, number>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.toFixed(2)]));
}

function computeProtocolLossNumbers(manifest: ProtocolManifest, state: HarnessState): Record<string, number> {
  const metadata = getHarnessMetadata(manifest);
  const losses: Record<string, number> = {};

  for (const asset of manifest.assets) {
    const initialReserve = Number(metadata.initialReserves?.[asset.symbol] ?? 0);
    const contributedToProtocol = totalHeldByProtocolForAsset(state, asset.symbol);
    const currentValue = (state.poolReserves[asset.symbol] ?? 0) + totalDebtForAsset(state, asset.symbol);
    const baselineValue = initialReserve + contributedToProtocol;
    losses[asset.symbol] = baselineValue - currentValue;
  }

  return losses;
}

function evaluateSemanticInvariants(semantics: SemanticModel, manifest: ProtocolManifest, state: HarnessState): InvariantFinding[] {
  const findings: InvariantFinding[] = [];

  for (const invariant of semantics.candidateInvariants) {
    if (invariant.source !== "derived") {
      continue;
    }

    if (invariant.kind === "solvency") {
      for (const role of manifest.roles) {
        const roleDebt = debtValue(state, role.id);
        const roleCollateral = collateralValue(state, role.id);
        if (roleDebt > roleCollateral * state.collateralFactor) {
          findings.push({
            invariantId: invariant.id,
            status: "violated",
            message: `${role.id} violates derived solvency guard`,
            severity: "critical"
          });
          break;
        }
      }
      continue;
    }

    if (invariant.kind === "profit") {
      const liquidAsset = semantics.assets.find((asset) => asset.role === "debt" || asset.role === "liquidity")?.symbol;
      if (!liquidAsset) {
        continue;
      }
      const protocolLoss = computeProtocolLossNumbers(manifest, state)[liquidAsset] ?? 0;
      if (protocolLoss > 0) {
        findings.push({
          invariantId: invariant.id,
          status: "violated",
          message: `Derived semantic oracle detected value extraction from ${liquidAsset}`,
          severity: "critical"
        });
      }
    }

    if (invariant.kind === "conservation" && semantics.archetype === "amm") {
      const negativeReserve = manifest.assets.find((asset) => (state.poolReserves[asset.symbol] ?? 0) < 0);
      if (negativeReserve) {
        findings.push({
          invariantId: invariant.id,
          status: "violated",
          message: `AMM reserve for ${negativeReserve.symbol} became negative`,
          severity: "critical"
        });
      }
    }
  }

  return findings;
}

function evaluateInvariants(manifest: ProtocolManifest, state: HarnessState, config?: CampaignConfig): InvariantFinding[] {
  const manifestFindings: InvariantFinding[] = manifest.invariants.map((invariant) => {
    if (invariant.kind === "solvency") {
      for (const role of manifest.roles) {
        const roleDebt = debtValue(state, role.id);
        const roleCollateral = collateralValue(state, role.id);
        if (roleDebt > roleCollateral * state.collateralFactor) {
          return {
            invariantId: invariant.id,
            status: "violated",
            message: `${role.id} debt ${roleDebt.toFixed(2)} exceeds collateral envelope ${
              (roleCollateral * state.collateralFactor).toFixed(2)
            }`,
            severity: invariant.severity
          };
        }
      }
    }

    if (invariant.kind === "conservation") {
      const targetAsset = String(invariant.config.asset ?? "");
      const reserve = state.poolReserves[targetAsset] ?? 0;
      if (reserve < 0) {
        return {
          invariantId: invariant.id,
          status: "violated",
          message: `${targetAsset} reserve dropped below zero`,
          severity: invariant.severity
        };
      }
    }

    return {
      invariantId: invariant.id,
      status: "ok",
      message: invariant.description,
      severity: invariant.severity
    };
  });

  if (config?.ablationMode === "manifest-only-invariants") {
    return manifestFindings;
  }

  const semantics = analyzeProtocolSemantics(manifest);
  return [...manifestFindings, ...evaluateSemanticInvariants(semantics, manifest, state)];
}

function evaluateEconomicOracles(
  manifest: ProtocolManifest,
  profitDeltaNumbers: Record<string, number>,
  protocolLossNumbers: Record<string, number>
): InvariantFinding[] {
  const metadata = getHarnessMetadata(manifest);
  const findings: InvariantFinding[] = [];
  const profitThreshold = Number(metadata.profitAlertThreshold ?? 1000);
  const protocolLossThreshold = Number(metadata.protocolLossAlertThreshold ?? 1000);

  for (const [actor, delta] of Object.entries(profitDeltaNumbers)) {
    if (delta >= profitThreshold) {
      findings.push({
        invariantId: `profit:${actor}`,
        status: "violated",
        message: `${actor} realized suspicious profit of ${delta.toFixed(2)}`,
        severity: "high"
      });
    }
  }

  for (const [asset, loss] of Object.entries(protocolLossNumbers)) {
    if (loss >= protocolLossThreshold) {
      findings.push({
        invariantId: `protocol-loss:${asset}`,
        status: "violated",
        message: `Protocol lost ${loss.toFixed(2)} units of ${asset}`,
        severity: "critical"
      });
    }
  }

  return findings;
}

export async function runLocalHarnessScenario(
  manifest: ProtocolManifest,
  scenario: Scenario,
  config?: CampaignConfig
): Promise<ExecutionResult> {
  const state = createInitialState(manifest);
  const steps: ExecutionResult["steps"] = [];
  let status: ExecutionResult["status"] = "ok";

  for (const [index, step] of scenario.steps.entries()) {
    try {
      const notes = applyAction(state, manifest, step);
      steps.push({ index, actor: step.actor, actionId: step.actionId, status: "ok", notes });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      steps.push({ index, actor: step.actor, actionId: step.actionId, status: "revert", notes: [message] });
      status = "revert";
      break;
    }
  }

  const profitDeltaNumbers = computeProfitDeltaNumbers(manifest, state);
  const protocolLossNumbers = computeProtocolLossNumbers(manifest, state);
  const invariantFindings = evaluateInvariants(manifest, state, config);
  const economicFindings = evaluateEconomicOracles(manifest, profitDeltaNumbers, protocolLossNumbers);
  const allFindings = [...invariantFindings, ...economicFindings];

  if (status === "ok" && invariantFindings.some((finding) => finding.status === "violated")) {
    status = "invariant-broken";
  } else if (status === "ok" && economicFindings.length > 0) {
    status = "oracle-hit";
  }

  const summary = status === "ok"
    ? "Scenario completed without oracle hits"
    : status === "revert"
      ? "Scenario reverted before completion"
      : status === "oracle-hit"
        ? "Scenario triggered an economic oracle"
        : "Scenario triggered at least one invariant finding";

  return {
    scenarioId: scenario.id,
    status,
    steps,
    profitDeltaByActor: formatNumericRecord(profitDeltaNumbers),
    protocolLosses: formatNumericRecord(protocolLossNumbers),
    invariantFindings: allFindings,
    summary
  };
}
