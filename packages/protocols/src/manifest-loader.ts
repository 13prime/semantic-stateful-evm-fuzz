import { readFile } from "node:fs/promises";

import { protocolManifestSchema, type ProtocolManifest } from "../../shared/src/index.js";
import { analyzeProtocolSemantics } from "./semantic-analysis.js";

export async function loadManifest(manifestPath: string): Promise<ProtocolManifest> {
  const raw = await readFile(manifestPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return protocolManifestSchema.parse(parsed);
}

export async function loadManifestWithSemantics(manifestPath: string) {
  const manifest = await loadManifest(manifestPath);
  const semantics = analyzeProtocolSemantics(manifest);
  return { manifest, semantics };
}
