import { z } from "zod";

export const foundryToolStatusSchema = z.object({
  name: z.enum(["anvil", "forge", "cast"]),
  available: z.boolean(),
  version: z.string().optional(),
  error: z.string().optional()
});

export const foundryToolingReportSchema = z.object({
  available: z.boolean(),
  tools: z.array(foundryToolStatusSchema)
});

export type FoundryToolStatus = z.infer<typeof foundryToolStatusSchema>;
export type FoundryToolingReport = z.infer<typeof foundryToolingReportSchema>;
