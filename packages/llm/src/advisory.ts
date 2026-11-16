import { z } from "zod";

import {
  llmSemanticExtractionSchema,
  semanticModelSchema,
  type LlmSemanticExtraction,
  type ProtocolManifest,
  type SemanticModel
} from "../../shared/src/index.js";

export const semanticAdvisoryReportSchema = z.object({
  protocolId: z.string().min(1),
  protocolName: z.string().min(1),
  baseSemantics: semanticModelSchema,
  advisoryExtraction: llmSemanticExtractionSchema,
  safetyNotes: z.array(z.string()).default([])
});

export type SemanticAdvisoryReport = z.infer<typeof semanticAdvisoryReportSchema>;

export function buildSemanticAdvisoryReport(
  manifest: ProtocolManifest,
  baseSemantics: SemanticModel,
  advisoryExtraction: LlmSemanticExtraction
): SemanticAdvisoryReport {
  return semanticAdvisoryReportSchema.parse({
    protocolId: manifest.id,
    protocolName: manifest.name,
    baseSemantics,
    advisoryExtraction,
    safetyNotes: [
      "LLM output is advisory only and must not directly mutate protocol manifests, scenarios, or oracle logic.",
      "Any suggested invariants or attack sketches must be normalized into local schemas and verified in the execution harness before use.",
      "Generated attack sketches are seed candidates, not executable transaction sequences."
    ]
  });
}
