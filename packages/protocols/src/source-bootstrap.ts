import { readFile } from "node:fs/promises";
import path from "node:path";

import parser from "@solidity-parser/parser";

import { buildManifestBootstrap } from "./abi-bootstrap.js";
import type { ProtocolManifest } from "../../shared/src/index.js";

interface SolidityFunctionStub {
  name: string;
  inputs: Array<{ name?: string; type: string }>;
}

interface SolidityModifierStub {
  name: string;
}

interface ParsedSourceMetadata {
  contractName: string;
  functions: SolidityFunctionStub[];
  stateVariables: string[];
  functionVisibility: Record<string, string>;
  functionMutability: Record<string, string>;
  functionModifiers: Record<string, string[]>;
  constructorPresent: boolean;
}

function normalizeContractName(rawContractName: string): string {
  return rawContractName.replace(/\.sol$/i, "");
}

function normalizeType(typeNode: unknown): string {
  if (!typeNode || typeof typeNode !== "object") {
    return "unknown";
  }

  const node = typeNode as { type?: string; name?: string; baseTypeName?: { namePath?: string }; path?: string; namePath?: string };
  if (node.type === "ElementaryTypeName") {
    return node.name ?? "unknown";
  }
  if (node.type === "UserDefinedTypeName") {
    return node.namePath ?? node.path ?? "unknown";
  }
  if (node.type === "ArrayTypeName" && "baseTypeName" in node) {
    return `${normalizeType(node.baseTypeName)}[]`;
  }
  return node.type ?? "unknown";
}

function readFunctionStubs(source: string, fallbackPath: string): ParsedSourceMetadata {
  const ast = parser.parse(source, { tolerant: true, range: true }) as {
    children?: Array<{
      type?: string;
      name?: string;
      subNodes?: Array<{
        type?: string;
        name?: string;
        visibility?: string;
        stateMutability?: string;
        isConstructor?: boolean;
        modifiers?: SolidityModifierStub[];
        variables?: Array<{ name?: string }>;
        parameters?: { parameters?: Array<{ name?: string; typeName?: unknown }> };
      }>;
    }>;
  };
  let selectedContractName = normalizeContractName(path.basename(fallbackPath, path.extname(fallbackPath)));
  const functions: SolidityFunctionStub[] = [];
  const stateVariables: string[] = [];
  const functionVisibility: Record<string, string> = {};
  const functionMutability: Record<string, string> = {};
  const functionModifiers: Record<string, string[]> = {};
  let constructorPresent = false;

  for (const child of ast.children ?? []) {
    if (child.type !== "ContractDefinition") {
      continue;
    }

    selectedContractName = child.name ?? selectedContractName;

    for (const subNode of child.subNodes ?? []) {
      if (subNode.type === "StateVariableDeclaration") {
        for (const variable of subNode.variables ?? []) {
          if (variable.name) {
            stateVariables.push(variable.name);
          }
        }
      }

      if (subNode.type === "FunctionDefinition") {
        if (subNode.isConstructor) {
          constructorPresent = true;
          continue;
        }
        if (!subNode.name) {
          continue;
        }
        const params = subNode.parameters?.parameters ?? [];
        functions.push({
          name: subNode.name,
          inputs: params.map((param) => ({
            name: param.name || undefined,
            type: normalizeType(param.typeName)
          }))
        });
        functionVisibility[subNode.name] = subNode.visibility ?? "default";
        functionMutability[subNode.name] = subNode.stateMutability ?? "nonpayable";
        functionModifiers[subNode.name] = (subNode.modifiers ?? []).map((modifier) => modifier.name);
      }
    }

    break;
  }

  return {
    contractName: selectedContractName,
    functions,
    stateVariables,
    functionVisibility,
    functionMutability,
    functionModifiers,
    constructorPresent
  };
}

export async function bootstrapManifestFromSource(
  sourcePath: string,
  options?: { contractName?: string; outputId?: string; chain?: "local-harness" | "anvil" }
): Promise<ProtocolManifest> {
  const source = await readFile(sourcePath, "utf8");
  const parsed = readFunctionStubs(source, sourcePath);
  const inferredContractName = options?.contractName ?? parsed.contractName;

  const manifest = buildManifestBootstrap(parsed.functions, inferredContractName, {
    outputId: options?.outputId,
    chain: options?.chain,
    sourcePath,
    sourceType: "solidity-bootstrap"
  });

  return {
    ...manifest,
    metadata: {
      ...manifest.metadata,
      sourceStateVariables: parsed.stateVariables,
      sourceFunctionVisibility: parsed.functionVisibility,
      sourceFunctionMutability: parsed.functionMutability,
      sourceFunctionModifiers: parsed.functionModifiers,
      sourceConstructorPresent: parsed.constructorPresent
    }
  };
}

export function buildSyntheticAbiFromSource(source: string, fallbackName = "Contract"): ParsedSourceMetadata {
  return readFunctionStubs(source, fallbackName);
}
