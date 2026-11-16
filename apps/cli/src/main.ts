import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runBenchmarkSuite, runComparisonReport } from "../../../packages/core/src/benchmark.js";
import { buildCampaignScenarios, executeCampaign, replayScenario } from "../../../packages/core/src/campaign.js";
import { formatFoundryToolingReport, inspectFoundryTooling } from "../../../packages/evm/src/index.js";
import {
  AnthropicLlmClient,
  buildSemanticAdvisoryReport,
  extractLlmSemantics,
  StubLlmClient
} from "../../../packages/llm/src/index.js";
import { bootstrapManifestFromAbi } from "../../../packages/protocols/src/abi-bootstrap.js";
import { buildScenarioCatalog } from "../../../packages/protocols/src/scenario-generator.js";
import { loadManifestWithSemantics } from "../../../packages/protocols/src/manifest-loader.js";
import { bootstrapManifestFromSource } from "../../../packages/protocols/src/source-bootstrap.js";
import {
  benchmarkSuiteSchema,
  campaignConfigSchema,
  type AblationMode,
  type BenchmarkCase,
  type LlmSemanticExtraction
} from "../../../packages/shared/src/index.js";

type Command =
  | "run"
  | "scenarios"
  | "replay"
  | "semantics"
  | "llm-semantics"
  | "benchmark"
  | "compare"
  | "bootstrap-abi"
  | "bootstrap-source"
  | "evm-status";

type BootstrapAfter = "none" | "semantics" | "scenarios" | "run";

interface ParsedArgs {
  command: Command;
  target?: string;
  scenarioId?: string;
  mode: AblationMode;
  writePath?: string;
  after: BootstrapAfter;
}

function parseMode(value?: string): AblationMode {
  switch (value) {
    case "full":
    case "no-llm":
    case "no-corpus":
    case "manifest-only-invariants":
    case "no-minimization":
      return value;
    default:
      return "full";
  }
}

function parseAfter(value?: string): BootstrapAfter {
  switch (value) {
    case "semantics":
    case "scenarios":
    case "run":
      return value;
    default:
      return "none";
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const [rawCommand = "run", ...rest] = argv;
  if (
    rawCommand !== "run" &&
    rawCommand !== "scenarios" &&
    rawCommand !== "replay" &&
    rawCommand !== "semantics" &&
    rawCommand !== "llm-semantics" &&
    rawCommand !== "benchmark" &&
    rawCommand !== "compare" &&
    rawCommand !== "bootstrap-abi" &&
    rawCommand !== "bootstrap-source" &&
    rawCommand !== "evm-status"
  ) {
    throw new Error(`Unsupported command: ${rawCommand}`);
  }

  let target: string | undefined;
  let scenarioId: string | undefined;
  let mode: AblationMode = "full";
  let writePath: string | undefined;
  let after: BootstrapAfter = "none";

  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === "--target") {
      target = rest[index + 1];
      index += 1;
      continue;
    }

    if (rest[index] === "--scenario") {
      scenarioId = rest[index + 1];
      index += 1;
      continue;
    }

    if (rest[index] === "--mode") {
      mode = parseMode(rest[index + 1]);
      index += 1;
      continue;
    }

    if (rest[index] === "--write") {
      writePath = rest[index + 1];
      index += 1;
      continue;
    }

    if (rest[index] === "--after") {
      after = parseAfter(rest[index + 1]);
      index += 1;
    }
  }

  return {
    command: rawCommand,
    target,
    scenarioId,
    mode,
    writePath,
    after
  };
}

async function loadTargetContext(target: string, mode: AblationMode) {
  const { manifest, semantics } = await loadManifestWithSemantics(target);
  const config = campaignConfigSchema.parse({
    target,
    ablationMode: mode,
    execution: { executor: manifest.chain }
  });

  return { manifest, semantics, config };
}

async function runCommand(target: string, mode: AblationMode): Promise<void> {
  const { manifest, config } = await loadTargetContext(target, mode);
  const campaignResult = await executeCampaign(manifest, config);
  const artifactDir = path.resolve(config.artifactDir);
  await mkdir(artifactDir, { recursive: true });
  const artifactPath = path.join(artifactDir, `${manifest.id}-latest.json`);
  await writeFile(artifactPath, JSON.stringify(campaignResult, null, 2));

  console.log(JSON.stringify({
    artifactPath,
    mode,
    manifestId: campaignResult.summary.manifestId,
    scenarioCount: campaignResult.summary.scenarioCount,
    topStatus: campaignResult.summary.topStatus,
    advisorySketchCount: campaignResult.advisory?.attackSketches.length ?? 0,
    advisoryLinkCount: campaignResult.advisoryLinks.length,
    advisoryInvariantCount: campaignResult.advisory?.invariantSuggestions.length ?? 0
  }, null, 2));
}

async function scenariosCommand(target: string, mode: AblationMode): Promise<void> {
  const { manifest, config } = await loadTargetContext(target, mode);
  const scenarios = await buildCampaignScenarios(manifest, config);
  const campaignResult = await executeCampaign(manifest, config);
  const catalog = buildScenarioCatalog(scenarios);

  console.log(
    JSON.stringify(
      {
        mode,
        manifestId: manifest.id,
        scenarioCount: catalog.length,
        scenarios: catalog,
        advisoryLinks: campaignResult.advisoryLinks
      },
      null,
      2
    )
  );
}

async function replayCommand(target: string, scenarioId: string, mode: AblationMode): Promise<void> {
  const { manifest, config } = await loadTargetContext(target, mode);
  const replay = await replayScenario(manifest, config, scenarioId);
  const campaignResult = await executeCampaign(manifest, config);
  const advisoryLink = campaignResult.advisoryLinks.find((link) => link.scenarioId === scenarioId) ?? null;

  console.log(
    JSON.stringify(
      {
        mode,
        manifestId: manifest.id,
        scenario: replay.scenario,
        advisoryLink,
        result: replay.result
      },
      null,
      2
    )
  );
}

async function semanticsCommand(target: string, mode: AblationMode): Promise<void> {
  const { semantics } = await loadTargetContext(target, mode);
  console.log(JSON.stringify({ mode, ...semantics }, null, 2));
}

function buildStubExtraction(protocolName: string): LlmSemanticExtraction {
  const lower = protocolName.toLowerCase();

  if (lower.includes("amm")) {
    return {
      protocolSummary: `${protocolName} appears sensitive to reserve shifts, swap sequencing, and reference-price shocks.`,
      protocolType: "amm",
      keyRisks: [
        "Swap paths can move reserves into unusual ratios.",
        "Reference price changes after swaps may expose accounting inconsistencies."
      ],
      invariantSuggestions: [
        {
          id: "llm-amm-conservation",
          kind: "conservation",
          rationale: "AMM reserve changes should remain bounded by swap inputs and outputs.",
          confidence: "high"
        }
      ],
      attackSketches: [
        {
          id: "amm-reserve-shift-seed",
          title: "Reserve shift roundtrip",
          objective: "Perform a large swap followed by a reverse swap to probe reserve conservation and trader profit.",
          preconditions: ["Swap actions exist for both pool directions"],
          steps: [
            "Seed liquidity on both sides of the pool.",
            "Swap into the thinner side of the pool.",
            "Swap back in the reverse direction.",
            "Measure reserve movement and trader profit."
          ],
          targetActions: ["swap"],
          confidence: "high"
        },
        {
          id: "amm-price-shock-seed",
          title: "Swap followed by price shock",
          objective: "Probe whether an oracle/reference-price update after a swap can create inconsistent valuation or reserve accounting.",
          preconditions: ["Swap action exists", "Price update action exists"],
          steps: [
            "Seed liquidity on both sides of the pool.",
            "Perform a one-sided swap.",
            "Apply a reference price update.",
            "Check reserve and profit invariants."
          ],
          targetActions: ["swap", "price-update"],
          confidence: "medium"
        }
      ],
      warnings: [
        "Stub output is advisory-only sample data for local development.",
        "Do not execute attack sketches directly; normalize them into scenario schemas first."
      ]
    };
  }

  return {
    protocolSummary: `${protocolName} behaves like a lending protocol with oracle-sensitive debt expansion and reserve-drain risk.`,
    protocolType: lower.includes("vault") ? "vault" : "lending",
    keyRisks: [
      "Oracle-sensitive collateral valuation can turn a previously healthy borrow into bad debt.",
      "Withdraw-like flows over the debt asset can create direct protocol loss if access control or accounting is weak."
    ],
    invariantSuggestions: [
      {
        id: "llm-collateral-envelope",
        kind: lower.includes("vault") ? "conservation" : "solvency",
        rationale: "Every borrower or depositor should remain within the intended accounting envelope after state changes.",
        confidence: "high"
      }
    ],
    attackSketches: lower.includes("vault")
      ? [
          {
            id: "reserve-drain-seed",
            title: "Reserve drain probe",
            objective: "Exercise withdraw paths against the primary underlying asset to detect direct loss or profit.",
            preconditions: ["A withdraw-like action exists"],
            steps: [
              "Seed liquidity to the pool.",
              "Deposit a moderate user position.",
              "Call the withdraw action over the primary underlying asset.",
              "Measure attacker profit and protocol loss."
            ],
            targetActions: ["withdraw"],
            confidence: "medium"
          }
        ]
      : [
          {
            id: "oracle-crash-seed",
            title: "Oracle-assisted bad debt",
            objective: "Borrow against collateral, then reduce collateral value via price change and check solvency failure.",
            preconditions: ["Borrow action exists", "A price-sensitive collateral asset exists"],
            steps: [
              "Supply debt-asset liquidity to the pool.",
              "Deposit the collateral asset.",
              "Borrow near the collateral limit.",
              "Apply an adverse oracle update and re-check solvency."
            ],
            targetActions: ["borrow", "price-update"],
            confidence: "high"
          }
        ],
    warnings: [
      "Stub output is advisory-only sample data for local development.",
      "Do not execute attack sketches directly; normalize them into scenario schemas first."
    ]
  };
}

async function llmSemanticsCommand(target: string, mode: AblationMode): Promise<void> {
  const { manifest, semantics } = await loadTargetContext(target, mode);

  let advisoryExtraction: LlmSemanticExtraction;
  let extractionMode: "live" | "stub" = "stub";

  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    try {
      advisoryExtraction = await extractLlmSemantics(new AnthropicLlmClient(), manifest, semantics);
      extractionMode = "live";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      advisoryExtraction = {
        ...buildStubExtraction(manifest.name),
        warnings: [
          `Live Claude extraction failed, so the CLI fell back to stub advisory output: ${message}`,
          ...buildStubExtraction(manifest.name).warnings
        ]
      };
    }
  } else {
    advisoryExtraction = buildStubExtraction(manifest.name);
  }

  const advisoryReport = buildSemanticAdvisoryReport(manifest, semantics, advisoryExtraction);

  console.log(JSON.stringify({ extractionMode, mode, ...advisoryReport }, null, 2));
}

async function benchmarkCommand(target: string, mode: AblationMode): Promise<void> {
  const raw = await readFile(target, "utf8");
  const suite = benchmarkSuiteSchema.parse(JSON.parse(raw) as unknown);
  const result = await runBenchmarkSuite(suite.id, suite.cases as BenchmarkCase[], { ablationMode: mode });
  console.log(JSON.stringify(result, null, 2));
}

async function compareCommand(target: string): Promise<void> {
  const raw = await readFile(target, "utf8");
  const suite = benchmarkSuiteSchema.parse(JSON.parse(raw) as unknown);
  const result = await runComparisonReport(suite.id, suite.cases as BenchmarkCase[], [
    "no-llm",
    "no-corpus",
    "manifest-only-invariants",
    "no-minimization"
  ]);
  console.log(JSON.stringify(result, null, 2));
}

async function bootstrapAbiCommand(target: string, mode: AblationMode, writePath?: string, after: BootstrapAfter = "none"): Promise<void> {
  const manifest = await bootstrapManifestFromAbi(target);
  await bootstrapFollowup(manifest, mode, writePath, after);
}

async function bootstrapSourceCommand(target: string, mode: AblationMode, writePath?: string, after: BootstrapAfter = "none"): Promise<void> {
  const manifest = await bootstrapManifestFromSource(target);
  await bootstrapFollowup(manifest, mode, writePath, after);
}

async function evmStatusCommand(): Promise<void> {
  const report = await inspectFoundryTooling();
  console.log(JSON.stringify({
    available: report.available,
    tools: report.tools,
    summary: formatFoundryToolingReport(report)
  }, null, 2));
}

async function bootstrapFollowup(
  manifest: Awaited<ReturnType<typeof bootstrapManifestFromAbi>>,
  mode: AblationMode,
  writePath?: string,
  after: BootstrapAfter = "none"
): Promise<void> {
  const resolvedWritePath = writePath ? path.resolve(writePath) : undefined;

  if (resolvedWritePath) {
    await mkdir(path.dirname(resolvedWritePath), { recursive: true });
    await writeFile(resolvedWritePath, JSON.stringify(manifest, null, 2));
  }

  if (after === "none") {
    console.log(JSON.stringify({
      writePath: resolvedWritePath ?? null,
      manifest
    }, null, 2));
    return;
  }

  const effectiveManifestPath = resolvedWritePath ?? path.resolve("artifacts", `${manifest.id}.manifest.json`);
  if (!resolvedWritePath) {
    await mkdir(path.dirname(effectiveManifestPath), { recursive: true });
    await writeFile(effectiveManifestPath, JSON.stringify(manifest, null, 2));
  }

  if (after === "semantics") {
    await semanticsCommand(effectiveManifestPath, mode);
    return;
  }

  if (after === "scenarios") {
    await scenariosCommand(effectiveManifestPath, mode);
    return;
  }

  await runCommand(effectiveManifestPath, mode);
}

async function main(): Promise<void> {
  const { command, target, scenarioId, mode, writePath, after } = parseArgs(process.argv.slice(2));

  if (command === "evm-status") {
    await evmStatusCommand();
    return;
  }

  if (!target) {
    throw new Error("Missing --target <manifest-path>");
  }

  if (command === "run") {
    await runCommand(target, mode);
    return;
  }

  if (command === "scenarios") {
    await scenariosCommand(target, mode);
    return;
  }

  if (command === "semantics") {
    await semanticsCommand(target, mode);
    return;
  }

  if (command === "llm-semantics") {
    await llmSemanticsCommand(target, mode);
    return;
  }

  if (command === "benchmark") {
    await benchmarkCommand(target, mode);
    return;
  }

  if (command === "compare") {
    await compareCommand(target);
    return;
  }

  if (command === "bootstrap-abi") {
    await bootstrapAbiCommand(target, mode, writePath, after);
    return;
  }

  if (command === "bootstrap-source") {
    await bootstrapSourceCommand(target, mode, writePath, after);
    return;
  }

  if (!scenarioId) {
    throw new Error("Missing --scenario <scenario-id>");
  }

  await replayCommand(target, scenarioId, mode);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
