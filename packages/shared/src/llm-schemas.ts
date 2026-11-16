import { z } from "zod";

export const semanticExtractionRequestSchema = z.object({
  protocolId: z.string().min(1),
  protocolName: z.string().min(1),
  manifestSummary: z.string().min(1),
  existingSemantics: z.record(z.string(), z.unknown())
});

export const llmInvariantSuggestionSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["solvency", "conservation", "profit", "access-control", "custom"]),
  rationale: z.string().min(1),
  confidence: z.enum(["low", "medium", "high"])
});

export const llmAttackSketchSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  objective: z.string().min(1),
  preconditions: z.array(z.string()).default([]),
  steps: z.array(z.string()).min(1),
  targetActions: z.array(z.string()).default([]),
  confidence: z.enum(["low", "medium", "high"])
});

export const llmSemanticExtractionSchema = z.object({
  protocolSummary: z.string().min(1),
  protocolType: z.enum(["lending", "vault", "amm", "staking", "unknown"]),
  keyRisks: z.array(z.string()).default([]),
  invariantSuggestions: z.array(llmInvariantSuggestionSchema).default([]),
  attackSketches: z.array(llmAttackSketchSchema).default([]),
  warnings: z.array(z.string()).default([])
});

export type SemanticExtractionRequest = z.infer<typeof semanticExtractionRequestSchema>;
export type LlmSemanticExtraction = z.infer<typeof llmSemanticExtractionSchema>;
export type LlmInvariantSuggestion = z.infer<typeof llmInvariantSuggestionSchema>;
export type LlmAttackSketch = z.infer<typeof llmAttackSketchSchema>;
