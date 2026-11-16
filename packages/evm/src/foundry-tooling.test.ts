import { describe, expect, it } from "vitest";

import { formatFoundryToolingReport, type FoundryToolingReport } from "./foundry-tooling.js";

describe("formatFoundryToolingReport", () => {
  it("reports available and missing tools", () => {
    const report: FoundryToolingReport = {
      available: false,
      tools: [
        { name: "anvil", available: true, version: "anvil 0.2.0" },
        { name: "forge", available: true, version: "forge 0.2.0" },
        { name: "cast", available: false, error: "not found" }
      ]
    };

    const formatted = formatFoundryToolingReport(report);
    expect(formatted).toContain("Detected: anvil (anvil 0.2.0), forge (forge 0.2.0)");
    expect(formatted).toContain("Missing: cast");
  });

  it("reports none when all tools are missing", () => {
    const report: FoundryToolingReport = {
      available: false,
      tools: [
        { name: "anvil", available: false },
        { name: "forge", available: false },
        { name: "cast", available: false }
      ]
    };

    expect(formatFoundryToolingReport(report)).toBe("Detected: none\nMissing: anvil, forge, cast");
  });
});
