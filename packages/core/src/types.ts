import type { ExecutionResult, ProtocolManifest, Scenario } from "../../shared/src/index.js";

export interface Executor {
  runScenario(manifest: ProtocolManifest, scenario: Scenario): Promise<ExecutionResult>;
}

export interface Oracle {
  evaluate(manifest: ProtocolManifest, result: ExecutionResult): ExecutionResult;
}
