import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { llmSemanticExtractionSchema, type LlmSemanticExtraction } from "../../shared/src/index.js";

function advisoryPath(artifactDir: string, manifestId: string, mode: string): string {
  return path.resolve(artifactDir, manifestId, `.advisory-${mode}.json`);
}

export async function loadAdvisorySnapshot(
  artifactDir: string,
  manifestId: string,
  mode: string
): Promise<LlmSemanticExtraction | null> {
  const filePath = advisoryPath(artifactDir, manifestId, mode);
  try {
    const raw = await readFile(filePath, "utf8");
    return llmSemanticExtractionSchema.parse(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export async function persistAdvisorySnapshot(
  artifactDir: string,
  manifestId: string,
  mode: string,
  advisory: LlmSemanticExtraction
): Promise<void> {
  const filePath = advisoryPath(artifactDir, manifestId, mode);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(advisory, null, 2));
}
