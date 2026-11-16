import { z } from "zod";

export const abiInputSchema = z.object({
  type: z.string(),
  name: z.string().optional(),
  inputs: z.array(z.object({ name: z.string().optional(), type: z.string() })).optional(),
  stateMutability: z.string().optional()
});

export const abiManifestBootstrapSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  chain: z.enum(["local-harness", "anvil"]),
  contracts: z.array(z.object({ name: z.string().min(1), tags: z.array(z.string()).default([]) })).min(1),
  assets: z.array(z.object({ symbol: z.string().min(1), decimals: z.number().int().nonnegative().max(36), priceSource: z.string().optional() })).default([]),
  roles: z.array(z.object({ id: z.string().min(1), description: z.string().min(1), initialBalances: z.record(z.string(), z.string()).default({}) })).min(1),
  actions: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    actorRole: z.string().min(1),
    contract: z.string().min(1),
    method: z.string().min(1),
    argsSchema: z.record(z.string(), z.string()).default({}),
    effectsHint: z.array(z.string()).default([]),
    config: z.record(z.string(), z.unknown()).default({})
  })).default([]),
  invariants: z.array(z.object({
    id: z.string().min(1),
    kind: z.enum(["solvency", "conservation", "access-control", "profit", "custom"]),
    description: z.string().min(1),
    severity: z.enum(["low", "medium", "high", "critical"]),
    config: z.record(z.string(), z.unknown()).default({})
  })).default([]),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export type AbiInput = z.infer<typeof abiInputSchema>;
export type AbiManifestBootstrap = z.infer<typeof abiManifestBootstrapSchema>;
