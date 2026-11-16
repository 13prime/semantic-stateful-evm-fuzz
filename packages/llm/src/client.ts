import Anthropic from "@anthropic-ai/sdk";
import type { ZodTypeAny, infer as Infer } from "zod";

export interface LlmClient {
  extractStructured<Schema extends ZodTypeAny>(prompt: string, schema: Schema): Promise<Infer<Schema>>;
}

function extractJsonObject(raw: string): string {
  const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return raw.trim();
  }

  return raw.slice(firstBrace, lastBrace + 1).trim();
}

function buildSchemaPrimer(schema: ZodTypeAny): string {
  const shape = schema.safeParse({});
  void shape;

  return [
    "Required top-level keys:",
    "- protocolSummary: string",
    "- protocolType: one of lending | vault | amm | staking | unknown",
    "- keyRisks: string[]",
    "- invariantSuggestions: array of {id, kind, rationale, confidence}",
    "- attackSketches: array of {id, title, objective, preconditions, steps, targetActions, confidence}",
    "- warnings: string[]",
    "Allowed invariant kinds: solvency | conservation | profit | access-control | custom",
    "If you want to use another invariant label such as logic or state-transition, map it to custom and explain the original meaning inside rationale."
  ].join("\n");
}

function normalizeInvariantKind(value: unknown): string {
  const lower = String(value ?? "custom").toLowerCase();
  if (["solvency", "conservation", "profit", "access-control", "custom"].includes(lower)) {
    return lower;
  }
  if (["logic", "state-transition", "accounting", "pricing"].includes(lower)) {
    return "custom";
  }
  return "custom";
}

function normalizeStructuredPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") {
    return payload;
  }

  const record = payload as Record<string, unknown>;
  const invariantSuggestions = Array.isArray(record.invariantSuggestions)
    ? record.invariantSuggestions.map((item) => {
        if (!item || typeof item !== "object") {
          return item;
        }
        const suggestion = item as Record<string, unknown>;
        const originalKind = String(suggestion.kind ?? "custom");
        const normalizedKind = normalizeInvariantKind(originalKind);
        return {
          ...suggestion,
          kind: normalizedKind,
          rationale: normalizedKind === "custom" && originalKind !== normalizedKind
            ? `[original-kind:${originalKind}] ${String(suggestion.rationale ?? "")}`.trim()
            : suggestion.rationale
        };
      })
    : record.invariantSuggestions;

  return {
    ...record,
    invariantSuggestions
  };
}

export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(options?: { apiKey?: string; model?: string }) {
    this.client = new Anthropic(options?.apiKey ? { apiKey: options.apiKey } : {});
    this.model = options?.model ?? "claude-opus-4-8";
  }

  async extractStructured<Schema extends ZodTypeAny>(prompt: string, schema: Schema): Promise<Infer<Schema>> {
    const augmentedPrompt = [
      prompt,
      buildSchemaPrimer(schema),
      "Return exactly one JSON object.",
      "Do not wrap the JSON in markdown fences.",
      "If a field is uncertain, still include it using a conservative value rather than omitting the field."
    ].join("\n\n");

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4000,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: augmentedPrompt }]
        }
      ]
    });

    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("Claude returned no textual semantic extraction payload");
    }

    const rawText = textBlock.text.trim();
    const jsonText = extractJsonObject(rawText);

    try {
      const parsed = JSON.parse(jsonText);
      return schema.parse(normalizeStructuredPayload(parsed)) as Infer<Schema>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Structured extraction validation failed. Raw response: ${rawText}\nValidation error: ${message}`);
    }
  }
}

export class StubLlmClient implements LlmClient {
  constructor(private readonly responseFactory: (prompt: string) => unknown) {}

  async extractStructured<Schema extends ZodTypeAny>(prompt: string, schema: Schema): Promise<Infer<Schema>> {
    return schema.parse(this.responseFactory(prompt));
  }
}
