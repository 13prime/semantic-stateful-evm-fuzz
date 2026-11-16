import { z } from "zod";

import { llmSemanticExtractionSchema } from "./llm-schemas.js";

export const contractSpecSchema = z.object({
  name: z.string().min(1),
  address: z.string().min(1).optional(),
  abiPath: z.string().min(1).optional(),
  artifactPath: z.string().min(1).optional(),
  tags: z.array(z.string()).default([])
});

export const assetSpecSchema = z.object({
  symbol: z.string().min(1),
  decimals: z.number().int().nonnegative().max(36),
  address: z.string().min(1).optional(),
  priceSource: z.string().min(1).optional()
});

export const roleSpecSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  initialBalances: z.record(z.string(), z.string()).default({})
});

export const predicateSpecSchema = z.object({
  kind: z.enum(["balance-gte", "state-eq", "custom"]),
  target: z.string().min(1),
  value: z.string().min(1),
  description: z.string().min(1).optional()
});

export const actionSpecSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  actorRole: z.string().min(1),
  contract: z.string().min(1),
  method: z.string().min(1),
  argsSchema: z.record(z.string(), z.string()).default({}),
  preconditions: z.array(predicateSpecSchema).default([]),
  effectsHint: z.array(z.string()).default([]),
  valueSource: z.enum(["template", "fuzzer", "llm"]).default("template"),
  config: z.record(z.string(), z.unknown()).default({})
});

export const invariantSpecSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["solvency", "conservation", "access-control", "profit", "custom"]),
  description: z.string().min(1),
  severity: z.enum(["low", "medium", "high", "critical"]),
  config: z.record(z.string(), z.unknown()).default({})
});

export const deploySpecSchema = z.object({
  mode: z.enum(["fixture", "script", "existing-addresses"]),
  entry: z.string().min(1),
  constructorArgs: z.array(z.unknown()).default([])
});

export const protocolManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  chain: z.enum(["local-harness", "anvil"]),
  contracts: z.array(contractSpecSchema).min(1),
  assets: z.array(assetSpecSchema).default([]),
  roles: z.array(roleSpecSchema).min(1),
  actions: z.array(actionSpecSchema).min(1),
  invariants: z.array(invariantSpecSchema).default([]),
  deploy: deploySpecSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export const scenarioStepSchema = z.object({
  actor: z.string().min(1),
  actionId: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({})
});

export const scenarioSchema = z.object({
  id: z.string().min(1),
  source: z.enum(["template", "llm", "mutation"]),
  goal: z.enum(["profit", "insolvency", "invariant-break"]).optional(),
  steps: z.array(scenarioStepSchema).min(1),
  assumptions: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([])
});

export const campaignConfigSchema = z.object({
  target: z.string().min(1),
  maxSequenceLength: z.number().int().positive().default(6),
  maxIterations: z.number().int().positive().default(100),
  seed: z.number().int().optional(),
  llmEnabled: z.boolean().default(false),
  ablationMode: z.enum(["full", "no-llm", "no-corpus", "manifest-only-invariants", "no-minimization"]).default("full"),
  artifactDir: z.string().min(1).default("artifacts"),
  execution: z.object({
    executor: z.enum(["local-harness", "anvil"]).default("local-harness")
  })
});

export const stepResultSchema = z.object({
  index: z.number().int().nonnegative(),
  actor: z.string().min(1),
  actionId: z.string().min(1),
  status: z.enum(["ok", "revert"]),
  notes: z.array(z.string()).default([])
});

export const invariantFindingSchema = z.object({
  invariantId: z.string().min(1),
  status: z.enum(["ok", "violated"]),
  message: z.string().min(1),
  severity: z.enum(["low", "medium", "high", "critical"])
});

export const executionResultSchema = z.object({
  scenarioId: z.string().min(1),
  status: z.enum(["ok", "revert", "oracle-hit", "invariant-broken"]),
  steps: z.array(stepResultSchema),
  profitDeltaByActor: z.record(z.string(), z.string()).default({}),
  protocolLosses: z.record(z.string(), z.string()).default({}),
  invariantFindings: z.array(invariantFindingSchema).default([]),
  traceRef: z.string().optional(),
  summary: z.string().min(1)
});

export const semanticActionFamilySchema = z.enum([
  "supply-liquidity",
  "deposit-collateral",
  "borrow",
  "repay",
  "withdraw",
  "swap",
  "price-update",
  "unknown"
]);

export const semanticAssetRoleSchema = z.enum(["collateral", "debt", "liquidity", "reference", "unknown"]);
export const protocolArchetypeSchema = z.enum(["lending", "vault", "amm", "staking", "unknown"]);

export const semanticRoleSchema = z.object({
  roleId: z.string().min(1),
  label: z.string().min(1),
  capabilities: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([])
});

export const semanticAssetSchema = z.object({
  symbol: z.string().min(1),
  role: semanticAssetRoleSchema,
  priceSource: z.string().min(1).optional(),
  priority: z.number().int().nonnegative().default(0)
});

export const semanticActionSchema = z.object({
  actionId: z.string().min(1),
  family: semanticActionFamilySchema,
  actorRole: z.string().min(1),
  targetAsset: z.string().min(1).optional(),
  dependsOnPrice: z.boolean(),
  riskTags: z.array(z.string()).default([])
});

export const semanticInvariantSchema = z.object({
  id: z.string().min(1),
  source: z.enum(["manifest", "derived"]),
  kind: z.string().min(1),
  rationale: z.string().min(1),
  priority: z.enum(["low", "medium", "high"])
});

export const semanticModelSchema = z.object({
  protocolId: z.string().min(1),
  protocolName: z.string().min(1),
  archetype: protocolArchetypeSchema,
  roles: z.array(semanticRoleSchema),
  assets: z.array(semanticAssetSchema),
  actions: z.array(semanticActionSchema),
  candidateInvariants: z.array(semanticInvariantSchema),
  notes: z.array(z.string()).default([])
});

export const scenarioCatalogEntrySchema = z.object({
  id: z.string().min(1),
  source: z.enum(["template", "llm", "mutation"]),
  goal: z.enum(["profit", "insolvency", "invariant-break"]).optional(),
  stepCount: z.number().int().positive(),
  tags: z.array(z.string()).default([]),
  originId: z.string().min(1).optional()
});

export const advisoryLinkSchema = z.object({
  scenarioId: z.string().min(1),
  advisoryAttackSketchId: z.string().min(1),
  advisoryAttackSketchTitle: z.string().min(1),
  targetActions: z.array(z.string()).default([])
});

export const campaignResultSchema = z.object({
  manifestId: z.string().min(1),
  scenarioCount: z.number().int().nonnegative(),
  semantics: semanticModelSchema,
  advisory: llmSemanticExtractionSchema.nullish(),
  advisoryLinks: z.array(advisoryLinkSchema).default([]),
  scenarios: z.array(scenarioCatalogEntrySchema),
  results: z.array(executionResultSchema),
  minimizations: z.array(
    z.object({
      originalScenarioId: z.string().min(1),
      minimizedScenario: scenarioSchema,
      result: executionResultSchema
    })
  ).default([]),
  summary: z.object({
    manifestId: z.string().min(1),
    scenarioCount: z.number().int().nonnegative(),
    topStatus: z.enum(["ok", "revert", "oracle-hit", "invariant-broken"])
  })
});

export type ProtocolManifest = z.infer<typeof protocolManifestSchema>;
export type ActionSpec = z.infer<typeof actionSpecSchema>;
export type InvariantSpec = z.infer<typeof invariantSpecSchema>;
export type Scenario = z.infer<typeof scenarioSchema>;
export type ScenarioStep = z.infer<typeof scenarioStepSchema>;
export type CampaignConfig = z.infer<typeof campaignConfigSchema>;
export type ExecutionResult = z.infer<typeof executionResultSchema>;
export type InvariantFinding = z.infer<typeof invariantFindingSchema>;
export type SemanticAction = z.infer<typeof semanticActionSchema>;
export type SemanticAsset = z.infer<typeof semanticAssetSchema>;
export type SemanticInvariant = z.infer<typeof semanticInvariantSchema>;
export type SemanticModel = z.infer<typeof semanticModelSchema>;
export type ScenarioCatalogEntry = z.infer<typeof scenarioCatalogEntrySchema>;
export type CampaignResult = z.infer<typeof campaignResultSchema>;
export type AdvisoryLink = z.infer<typeof advisoryLinkSchema>;
