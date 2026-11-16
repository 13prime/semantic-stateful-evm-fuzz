import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback, spawn } from "node:child_process";

import type { CampaignConfig, ExecutionResult, ProtocolManifest, Scenario } from "../../shared/src/index.js";
import { formatFoundryToolingReport, inspectFoundryTooling } from "./foundry-tooling.js";

const execFile = promisify(execFileCallback);

interface DeployedVaultFixture {
  rpcUrl: string;
  anvil?: ReturnType<typeof spawn>;
  tokenAddress: string;
  vaultAddress: string;
  accounts: {
    deployer: string;
    liquidityProvider: string;
    vaultUser: string;
  };
  workDir: string;
}

const ANVIL_PORT = 8547;
const ANVIL_RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const ANVIL_KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
} as const;
const ANVIL_ACCOUNTS = {
  deployer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  liquidityProvider: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  vaultUser: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
} as const;

async function waitForAnvil(rpcUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await execFile("cast", ["block-number", "--rpc-url", rpcUrl]);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("Timed out waiting for anvil to start");
}

async function deployToyVaultFixture(): Promise<DeployedVaultFixture> {
  const workDir = await mkdtemp(path.join(os.tmpdir(), "toy-vault-anvil-"));
  const anvil = spawn("anvil", ["--port", String(ANVIL_PORT)], {
    stdio: "ignore"
  });
  await waitForAnvil(ANVIL_RPC);

  const tokenArtifact = path.resolve("contracts/out/ToyVault.sol/MockERC20.json");
  const vaultArtifact = path.resolve("contracts/out/ToyVault.sol/ToyVault.json");

  const tokenDeploy = await execFile("forge", [
    "create",
    "contracts/src/ToyVault.sol:MockERC20",
    "--rpc-url",
    ANVIL_RPC,
    "--private-key",
    ANVIL_KEYS.deployer,
    "--broadcast",
    "--constructor-args",
    "MockUSDC",
    "USDC",
    "6"
  ], { cwd: path.resolve(".") });

  const tokenAddressMatch = `${tokenDeploy.stdout}${tokenDeploy.stderr}`.match(/Deployed to: (0x[a-fA-F0-9]{40})/);
  if (!tokenAddressMatch) {
    throw new Error(`Could not parse token deployment output: ${tokenDeploy.stdout}${tokenDeploy.stderr}`);
  }
  const tokenAddress = tokenAddressMatch[1];

  const vaultDeploy = await execFile("forge", [
    "create",
    "contracts/src/ToyVault.sol:ToyVault",
    "--rpc-url",
    ANVIL_RPC,
    "--private-key",
    ANVIL_KEYS.deployer,
    "--broadcast",
    "--constructor-args",
    tokenAddress
  ], { cwd: path.resolve(".") });

  const vaultAddressMatch = `${vaultDeploy.stdout}${vaultDeploy.stderr}`.match(/Deployed to: (0x[a-fA-F0-9]{40})/);
  if (!vaultAddressMatch) {
    throw new Error(`Could not parse vault deployment output: ${vaultDeploy.stdout}${vaultDeploy.stderr}`);
  }
  const vaultAddress = vaultAddressMatch[1];

  void tokenArtifact;
  void vaultArtifact;

  return {
    rpcUrl: ANVIL_RPC,
    anvil,
    tokenAddress,
    vaultAddress,
    accounts: ANVIL_ACCOUNTS,
    workDir
  };
}

async function sendFromUnlockedAccount(fixture: DeployedVaultFixture, from: string, to: string, signature: string, ...args: string[]): Promise<void> {
  await execFile("cast", ["send", to, signature, ...args, "--unlocked", "--from", from, "--rpc-url", fixture.rpcUrl]);
}

async function mintAndApprove(fixture: DeployedVaultFixture): Promise<void> {
  await execFile("cast", ["send", fixture.tokenAddress, "mint(address,uint256)", fixture.accounts.liquidityProvider, "60000000", "--private-key", ANVIL_KEYS.deployer, "--rpc-url", fixture.rpcUrl]);
  await execFile("cast", ["send", fixture.tokenAddress, "mint(address,uint256)", fixture.accounts.vaultUser, "15000000", "--private-key", ANVIL_KEYS.deployer, "--rpc-url", fixture.rpcUrl]);
  await sendFromUnlockedAccount(fixture, fixture.accounts.liquidityProvider, fixture.tokenAddress, "approve(address,uint256)", fixture.vaultAddress, "1000000000");
  await sendFromUnlockedAccount(fixture, fixture.accounts.vaultUser, fixture.tokenAddress, "approve(address,uint256)", fixture.vaultAddress, "1000000000");
}

function actorAddress(fixture: DeployedVaultFixture, actor: string): string {
  switch (actor) {
    case "liquidityProvider":
      return fixture.accounts.liquidityProvider;
    case "vaultUser":
      return fixture.accounts.vaultUser;
    default:
      return fixture.accounts.deployer;
  }
}

async function callVaultAction(fixture: DeployedVaultFixture, actor: string, actionId: string, amount: number): Promise<void> {
  const from = actorAddress(fixture, actor);
  if (actionId === "seed-vault-liquidity" || actionId === "user-deposit-usdc") {
    await sendFromUnlockedAccount(fixture, from, fixture.vaultAddress, "deposit(uint256)", String(amount));
    return;
  }
  if (actionId === "user-redeem-safe") {
    await sendFromUnlockedAccount(fixture, from, fixture.vaultAddress, "redeem(uint256)", String(amount));
    return;
  }
  if (actionId === "user-withdraw-excess") {
    await sendFromUnlockedAccount(fixture, from, fixture.vaultAddress, "withdrawExcess(uint256)", String(amount));
    return;
  }
  throw new Error(`Unsupported ToyVault action: ${actionId}`);
}

function parseUint256Output(raw: string): number {
  const trimmed = raw.trim();
  const primaryToken = trimmed.split(/\s+/)[0];
  if (/^0x[0-9a-fA-F]+$/.test(primaryToken)) {
    return Number(BigInt(primaryToken));
  }
  if (/^[0-9]+$/.test(primaryToken)) {
    return Number(BigInt(primaryToken));
  }
  throw new Error(`Unsupported numeric output from cast call: ${trimmed}`);
}

async function readBalance(fixture: DeployedVaultFixture, address: string): Promise<number> {
  const { stdout } = await execFile("cast", ["call", fixture.tokenAddress, "balanceOf(address)(uint256)", address, "--rpc-url", fixture.rpcUrl]);
  return parseUint256Output(stdout);
}

async function readReserve(fixture: DeployedVaultFixture): Promise<number> {
  const { stdout } = await execFile("cast", ["call", fixture.vaultAddress, "totalReserves()(uint256)", "--rpc-url", fixture.rpcUrl]);
  return parseUint256Output(stdout);
}

export async function runAnvilScenario(
  manifest: ProtocolManifest,
  scenario: Scenario,
  config?: CampaignConfig
): Promise<ExecutionResult> {
  void config;

  const tooling = await inspectFoundryTooling();
  if (!tooling.available) {
    throw new Error([
      "Anvil executor is not available in this environment.",
      formatFoundryToolingReport(tooling),
      "Install Foundry (anvil, forge, cast) before running real EVM-backed scenarios."
    ].join("\n"));
  }

  if (!manifest.id.startsWith("toy-vault")) {
    throw new Error([
      `Real EVM execution is currently implemented only for toy-vault manifests.`,
      `Received manifest: ${manifest.id}`,
      "Next implementation step: map additional manifests to Solidity fixtures or existing deployed addresses."
    ].join("\n"));
  }

  const fixture = await deployToyVaultFixture();
  try {
    await mintAndApprove(fixture);

    const initialUserBalance = await readBalance(fixture, fixture.accounts.vaultUser);
    const initialReserve = await readReserve(fixture);
    const steps: ExecutionResult["steps"] = [];
    let status: ExecutionResult["status"] = "ok";

    for (const [index, step] of scenario.steps.entries()) {
      try {
        const amount = Number(step.args.amount ?? 0);
        await callVaultAction(fixture, step.actor, step.actionId, amount);
        steps.push({
          index,
          actor: step.actor,
          actionId: step.actionId,
          status: "ok",
          notes: [`Executed ${step.actionId} via Anvil-backed ToyVault fixture`]
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        steps.push({
          index,
          actor: step.actor,
          actionId: step.actionId,
          status: "revert",
          notes: [message]
        });
        status = "revert";
        break;
      }
    }

    const finalUserBalance = await readBalance(fixture, fixture.accounts.vaultUser);
    const finalReserve = await readReserve(fixture);
    const profit = finalUserBalance - initialUserBalance;
    const reserveLoss = initialReserve - finalReserve;

    const profitFinding = profit > 0
      ? {
          invariantId: "anvil-vault-profit",
          status: "violated" as const,
          message: `Vault user realized ${profit} units of USDC on-chain`,
          severity: "high" as const
        }
      : {
          invariantId: "anvil-vault-profit",
          status: "ok" as const,
          message: "Vault user profit remained bounded",
          severity: "high" as const
        };
    const reserveFinding = reserveLoss > 0
      ? {
          invariantId: "anvil-vault-reserve-loss",
          status: "violated" as const,
          message: `Vault reserve changed by ${reserveLoss}`,
          severity: "critical" as const
        }
      : {
          invariantId: "anvil-vault-reserve-loss",
          status: "ok" as const,
          message: "Vault reserves preserved",
          severity: "critical" as const
        };
    const invariantFindings = [profitFinding, reserveFinding];

    if (status === "ok" && (reserveLoss > 0 || profit > 0)) {
      status = "invariant-broken";
    }

    return {
      scenarioId: scenario.id,
      status,
      steps,
      profitDeltaByActor: {
        vaultUser: profit.toFixed(2)
      },
      protocolLosses: {
        USDC: reserveLoss.toFixed(2)
      },
      invariantFindings,
      summary: status === "ok"
        ? "Scenario completed on Anvil-backed ToyVault fixture"
        : status === "revert"
          ? "Scenario reverted on Anvil-backed ToyVault fixture"
          : "Scenario triggered invariant findings on Anvil-backed ToyVault fixture"
    };
  } finally {
    fixture.anvil?.kill();
    await rm(fixture.workDir, { recursive: true, force: true });
  }
}
