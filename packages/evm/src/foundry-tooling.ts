import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";

const execFile = promisify(execFileCallback);

export interface FoundryToolStatus {
  name: "anvil" | "forge" | "cast";
  available: boolean;
  version?: string;
  error?: string;
}

export interface FoundryToolingReport {
  available: boolean;
  tools: FoundryToolStatus[];
}

async function inspectTool(name: FoundryToolStatus["name"]): Promise<FoundryToolStatus> {
  try {
    const { stdout, stderr } = await execFile(name, ["--version"]);
    return {
      name,
      available: true,
      version: `${stdout}${stderr}`.trim()
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name,
      available: false,
      error: message
    };
  }
}

export async function inspectFoundryTooling(): Promise<FoundryToolingReport> {
  const tools = await Promise.all([
    inspectTool("anvil"),
    inspectTool("forge"),
    inspectTool("cast")
  ]);

  return {
    available: tools.every((tool) => tool.available),
    tools
  };
}

export function formatFoundryToolingReport(report: FoundryToolingReport): string {
  const available = report.tools.filter((tool) => tool.available);
  const missing = report.tools.filter((tool) => !tool.available);

  const lines = [
    available.length > 0
      ? `Detected: ${available.map((tool) => `${tool.name} (${tool.version ?? "ok"})`).join(", ")}`
      : "Detected: none",
    missing.length > 0
      ? `Missing: ${missing.map((tool) => tool.name).join(", ")}`
      : "Missing: none"
  ];

  return lines.join("\n");
}
