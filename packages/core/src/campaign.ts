import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { runAnvilScenario, runLocalHarnessScenario } from "../../evm/src/index.js";
import { AnthropicLlmClient, StubLlmClient, extractLlmSemantics } from "../../llm/src/index.js";
import { buildAdvisoryLinks, buildLlmSeedScenarios } from "../../protocols/src/llm-seed-adapter.js";
import { analyzeProtocolSemantics } from "../../protocols/src/semantic-analysis.js";
import { buildScenarioCatalog, buildSeedScenarios, findScenarioById } from "../../protocols/src/scenario-generator.js";
import {
  campaignConfigSchema,
  campaignResultSchema,
  executionResultSchema,
  type AblationMode,
  type CampaignConfig,
  type CampaignResult,
  type ExecutionResult,
  type LlmSemanticExtraction,
  type ProtocolManifest,
  type Scenario
} from "../../shared/src/index.js";
import { loadAdvisorySnapshot, persistAdvisorySnapshot } from "./advisory-cache.js";
import { expandScenarioCorpus, selectInterestingScenarios } from "./corpus.js";
import { minimizeInterestingScenario } from "./minimizer.js";
import { rankResults } from "./ranking.js";

async function executeScenario(
  manifest: ProtocolManifest,
  scenario: Scenario,
  config?: CampaignConfig
): Promise<ExecutionResult> {
  if (manifest.chain === "anvil") {
    return runAnvilScenario(manifest, scenario);
  }

  return runLocalHarnessScenario(manifest, scenario, config);
}

function uniqueScenarioList(scenarios: Scenario[]): Scenario[] {
  const seen = new Set<string>();
  const unique: Scenario[] = [];

  for (const scenario of scenarios) {
    const key = JSON.stringify(scenario.steps);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(scenario);
  }

  return unique;
}

async function evaluateScenarios(
  manifest: ProtocolManifest,
  scenarios: Scenario[],
  config?: CampaignConfig
): Promise<ExecutionResult[]> {
  const results: ExecutionResult[] = [];

  for (const scenario of scenarios) {
    results.push(executionResultSchema.parse(await executeScenario(manifest, scenario, config)));
  }

  return results;
}

function buildFallbackAdvisory(manifest: ProtocolManifest): LlmSemanticExtraction {
  const lower = manifest.name.toLowerCase();

  if (lower.includes("amm")) {
    return {
      protocolSummary: `${manifest.name} appears sensitive to reserve shifts, swap sequencing, and reference-price shocks.`,
      protocolType: "amm",
      keyRisks: [
        "Swap paths can move reserves into unusual ratios.",
        "Reference price changes after swaps may expose accounting inconsistencies."
      ],
      invariantSuggestions: [
        {
          id: `${manifest.id}-llm-amm-conservation`,
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
        "Fallback advisory output is locally generated and must still be validated in the harness.",
        "LLM-derived sketches are seed candidates only."
      ]
    };
  }

  return {
    protocolSummary: `${manifest.name} behaves like a lending protocol with oracle-sensitive debt expansion and reserve-drain risk.`,
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
      "Fallback advisory output is locally generated and must still be validated in the harness.",
      "LLM-derived sketches are seed candidates only."
    ]
  };
}

function getAblationMode(config: CampaignConfig): AblationMode {
  return config.ablationMode ?? "full";
}

async function resolveAdvisory(manifest: ProtocolManifest, semantics: ReturnType<typeof analyzeProtocolSemantics>, config: CampaignConfig) {
  const mode = getAblationMode(config);
  if (mode === "no-llm") {
    return null;
  }

  const cached = await loadAdvisorySnapshot(config.artifactDir, manifest.id, mode);
  if (cached) {
    return cached;
  }

  let advisory: LlmSemanticExtraction;
  if (config.llmEnabled && (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)) {
    try {
      advisory = await extractLlmSemantics(new AnthropicLlmClient(), manifest, semantics);
    } catch {
      advisory = await extractLlmSemantics(new StubLlmClient(() => buildFallbackAdvisory(manifest)), manifest, semantics);
    }
  } else {
    advisory = await extractLlmSemantics(new StubLlmClient(() => buildFallbackAdvisory(manifest)), manifest, semantics);
  }

  await persistAdvisorySnapshot(config.artifactDir, manifest.id, mode, advisory);
  return advisory;
}

export async function resolveCampaignInputs(manifest: ProtocolManifest, input: CampaignConfig) {
  const config = campaignConfigSchema.parse(input);
  const semantics = analyzeProtocolSemantics(manifest);
  const mode = getAblationMode(config);
  const advisory = await resolveAdvisory(manifest, semantics, config);
  const baseScenarios = buildSeedScenarios(manifest, config).slice(0, config.maxIterations);
  const llmSeedScenarios = advisory ? buildLlmSeedScenarios(manifest, semantics, advisory) : [];
  const initialScenarios = uniqueScenarioList([...baseScenarios, ...llmSeedScenarios]).slice(0, config.maxIterations);
  const advisoryLinks = buildAdvisoryLinks(initialScenarios, advisory);

  return { config, semantics, advisory, initialScenarios, advisoryLinks, mode };
}

export async function buildCampaignScenarios(manifest: ProtocolManifest, input: CampaignConfig): Promise<Scenario[]> {
  const { config, initialScenarios, mode } = await resolveCampaignInputs(manifest, input);
  if (mode === "no-corpus") {
    return initialScenarios;
  }

  const baseResults = await evaluateScenarios(manifest, initialScenarios, config);
  const interesting = selectInterestingScenarios(initialScenarios, baseResults, Math.min(3, initialScenarios.length));
  const expandedCandidates = uniqueScenarioList(expandScenarioCorpus(interesting, 1)).filter(
    (candidate) => !findScenarioById(initialScenarios, candidate.id)
  );
  const remainingBudget = Math.max(0, config.maxIterations - initialScenarios.length);
  const expandedScenarios = expandedCandidates.slice(0, remainingBudget);
  return uniqueScenarioList([...initialScenarios, ...expandedScenarios]).slice(0, config.maxIterations);
}

export async function executeCampaign(manifest: ProtocolManifest, input: CampaignConfig): Promise<CampaignResult> {
  const { config, semantics, advisory, mode } = await resolveCampaignInputs(manifest, input);
  const scenarios = await buildCampaignScenarios(manifest, config);
  const advisoryLinks = buildAdvisoryLinks(scenarios, advisory);
  const results: ExecutionResult[] = [];
  const artifactRoot = path.resolve(config.artifactDir, manifest.id);
  await mkdir(artifactRoot, { recursive: true });

  for (const scenario of scenarios) {
    const result = executionResultSchema.parse(await executeScenario(manifest, scenario, config));
    results.push(result);
    const scenarioArtifactPath = path.join(artifactRoot, `${scenario.id}.json`);
    await writeFile(scenarioArtifactPath, JSON.stringify(result, null, 2));
  }

  const interesting = selectInterestingScenarios(scenarios, results, 3);
  const minimizations: Array<{ originalScenarioId: string; minimizedScenario: Scenario; result: ExecutionResult }> = [];

  if (mode !== "no-minimization") {
    for (const scenario of interesting) {
      const minimized = await minimizeInterestingScenario(scenario, async (candidate) => {
        return executionResultSchema.parse(await executeScenario(manifest, candidate, config));
      });

      if (!minimized) {
        continue;
      }

      minimizations.push({
        originalScenarioId: scenario.id,
        minimizedScenario: minimized.minimizedScenario,
        result: minimized.result
      });
    }
  }

  const rankedResults = rankResults(results, advisoryLinks);

  return campaignResultSchema.parse({
    manifestId: manifest.id,
    scenarioCount: scenarios.length,
    semantics,
    advisory,
    advisoryLinks,
    scenarios: buildScenarioCatalog(scenarios),
    results: rankedResults,
    minimizations,
    summary: {
      manifestId: manifest.id,
      scenarioCount: scenarios.length,
      topStatus: rankedResults[0]?.status ?? "ok"
    }
  });
}

export async function replayScenario(
  manifest: ProtocolManifest,
  input: CampaignConfig,
  scenarioId: string
): Promise<{ scenario: Scenario; result: ExecutionResult }> {
  const { config } = await resolveCampaignInputs(manifest, input);
  const scenarios = await buildCampaignScenarios(manifest, config);
  const scenario = findScenarioById(scenarios, scenarioId);

  if (!scenario) {
    throw new Error(`Unknown scenario id: ${scenarioId}`);
  }

  const result = executionResultSchema.parse(await executeScenario(manifest, scenario, config));
  return { scenario, result };
}
