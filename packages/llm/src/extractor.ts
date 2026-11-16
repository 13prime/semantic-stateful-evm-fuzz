import {
  llmSemanticExtractionSchema,
  type LlmSemanticExtraction,
  type ProtocolManifest,
  type SemanticExtractionRequest,
  type SemanticModel
} from "../../shared/src/index.js";
import type { LlmClient } from "./client.js";

export function buildSemanticExtractionPrompt(input: SemanticExtractionRequest): string {
  return [
    "You are assisting a Web3 security fuzzing system.",
    "Return only structured JSON matching the schema.",
    "Treat your output as advisory analysis, not executable instructions.",
    "Do not invent contracts, actions, assets, or privileges that are absent from the provided manifest summary.",
    "Suggested invariants and attack sketches are candidate ideas for later validation, not authoritative findings.",
    `Protocol ID: ${input.protocolId}`,
    `Protocol Name: ${input.protocolName}`,
    `Manifest Summary: ${input.manifestSummary}`,
    `Existing Semantics: ${JSON.stringify(input.existingSemantics, null, 2)}`,
    "Suggest protocol summary, risks, candidate invariants, and attack sketches."
  ].join("\n\n");
}

export function summarizeManifestForLlm(manifest: ProtocolManifest, semantics: SemanticModel): string {
  return JSON.stringify(
    {
      contracts: manifest.contracts.map((contract) => ({ name: contract.name, tags: contract.tags })),
      roles: manifest.roles.map((role) => ({ id: role.id, description: role.description })),
      actions: semantics.actions,
      invariants: manifest.invariants.map((invariant) => ({ id: invariant.id, kind: invariant.kind, description: invariant.description }))
    },
    null,
    2
  );
}

export async function extractLlmSemantics(
  client: LlmClient,
  manifest: ProtocolManifest,
  semantics: SemanticModel
): Promise<LlmSemanticExtraction> {
  const prompt = buildSemanticExtractionPrompt({
    protocolId: manifest.id,
    protocolName: manifest.name,
    manifestSummary: summarizeManifestForLlm(manifest, semantics),
    existingSemantics: semantics
  });

  const result = await client.extractStructured(prompt, llmSemanticExtractionSchema);
  return llmSemanticExtractionSchema.parse(result);
}
