import { buildDynamicSubfieldCatalog, resolveDynamicSubfields } from "./dynamicSubfields";
import { buildFieldExplainMarkdown } from "./explain";
import { resolveUiHint } from "./uiHints";
import type {
  CompletionPrimitive,
  DynamicSubfieldCatalog,
} from "./types";

type JsonSchemaNode = {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  additionalProperties?: boolean | JsonSchemaNode;
  items?: JsonSchemaNode;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  examples?: unknown[];
  title?: string;
  description?: string;
};

type UiHintRecord = Record<string, { label?: string; help?: string }>;

export type KeyContract = {
  parentPatternPath: string;
  parentConcretePath: string;
  key: string;
  fullPatternPath: string;
  fullConcretePath: string;
  hint?: { label?: string; help?: string };
};

export type ValueContract = {
  parentConcretePath: string;
  key: string;
  fullConcretePath: string;
  values: CompletionPrimitive[];
  hint?: { label?: string; help?: string };
};

export type StrictObjectContract = {
  path: string;
  unknownKey: string;
};

export type SensitiveContract = {
  path: string;
};

export type SchemaContractMatrix = {
  catalog: DynamicSubfieldCatalog;
  keyContracts: KeyContract[];
  valueContracts: ValueContract[];
  strictObjectContracts: StrictObjectContract[];
  sensitiveContracts: SensitiveContract[];
  hintPaths: string[];
  syntheticConfig: Record<string, unknown>;
};

export function createSchemaContractMatrix(
  schemaText: string,
  uiHintsText: string,
): SchemaContractMatrix {
  const schema = JSON.parse(schemaText) as JsonSchemaNode;
  const uiHints = JSON.parse(uiHintsText) as UiHintRecord;
  const catalog = buildDynamicSubfieldCatalog(schemaText, uiHintsText, []);
  const keyContracts: KeyContract[] = [];
  const valueContracts: ValueContract[] = [];
  const strictObjectContracts: StrictObjectContract[] = [];
  const sensitiveContracts: SensitiveContract[] = [];

  walkSchema({
    node: schema,
    uiHints,
    patternSegments: [],
    concreteSegments: [],
    keyContracts,
    valueContracts,
    strictObjectContracts,
    sensitiveContracts,
  });

  return {
    catalog,
    keyContracts,
    valueContracts,
    strictObjectContracts,
    sensitiveContracts,
    hintPaths: Object.keys(uiHints).sort((left, right) => left.localeCompare(right)),
    syntheticConfig: buildSyntheticConfig(schema, []),
  };
}

export function assertKeyPresentInCatalog(contract: KeyContract, catalog: DynamicSubfieldCatalog): boolean {
  return resolveDynamicSubfields(catalog, contract.parentConcretePath)
    .some((entry) => entry.key === contract.key);
}

export function buildHoverMarkdown(
  path: string,
  catalog: DynamicSubfieldCatalog,
  uiHintsText: string,
): string {
  return buildFieldExplainMarkdown(path, catalog, uiHintsText, null);
}

export function buildKeyCompletionDocument(parentConcretePath: string): { text: string; marker: string } {
  const marker = "__KEY_MARKER__";
  return {
    text: wrapAsJson(buildNestedStructure(toSegments(parentConcretePath), marker, "key")),
    marker,
  };
}

export function buildValueCompletionDocument(
  parentConcretePath: string,
  key: string,
): { text: string; marker: string } {
  const marker = "__VALUE_MARKER__";
  return {
    text: wrapAsJson(buildNestedStructure(toSegments(parentConcretePath), marker, "value", key)),
    marker,
  };
}

function walkSchema(params: {
  node: JsonSchemaNode;
  uiHints: UiHintRecord;
  patternSegments: string[];
  concreteSegments: string[];
  keyContracts: KeyContract[];
  valueContracts: ValueContract[];
  strictObjectContracts: StrictObjectContract[];
  sensitiveContracts: SensitiveContract[];
}): void {
  const properties = collectProperties(params.node);
  const currentPatternPath = params.patternSegments.join(".");
  const currentConcretePath = params.concreteSegments.join(".");

  if (
    params.patternSegments.length > 0 &&
    isObjectNode(params.node) &&
    params.node.additionalProperties === false &&
    properties.size > 0
  ) {
    params.strictObjectContracts.push({
      path: currentConcretePath,
      unknownKey: "ghostSetting",
    });
  }

  for (const [key, child] of properties.entries()) {
    const fullPatternPath = [...params.patternSegments, key].join(".");
    const fullConcretePath = [...params.concreteSegments, key].join(".");
    const hint = resolveHint(params.uiHints, fullPatternPath);
    params.keyContracts.push({
      parentPatternPath: currentPatternPath,
      parentConcretePath: currentConcretePath,
      key,
      fullPatternPath,
      fullConcretePath,
      hint,
    });

    const values = inferValueCandidates(child);
    if (values.length > 0) {
      params.valueContracts.push({
        parentConcretePath: currentConcretePath,
        key,
        fullConcretePath,
        values,
        hint,
      });
    }
    if (looksSensitiveKey(key) && allowsStringLikeValue(child)) {
      params.sensitiveContracts.push({ path: fullConcretePath });
    }

    walkSchema({
      ...params,
      node: child,
      patternSegments: [...params.patternSegments, key],
      concreteSegments: [...params.concreteSegments, key],
    });
  }

  if (isObjectNode(params.node.additionalProperties)) {
    walkSchema({
      ...params,
      node: params.node.additionalProperties,
      patternSegments: [...params.patternSegments, "*"],
      concreteSegments: [...params.concreteSegments, "default"],
    });
  }

  if (isObjectNode(params.node.items)) {
    walkSchema({
      ...params,
      node: params.node.items,
      patternSegments: [...params.patternSegments, "*"],
      concreteSegments: [...params.concreteSegments, "0"],
    });
  }
}

function buildSyntheticConfig(node: JsonSchemaNode, pathSegments: string[]): Record<string, unknown> {
  const properties = collectProperties(node);
  const next: Record<string, unknown> = {};
  for (const [key, child] of properties.entries()) {
    const fullPath = [...pathSegments, key].join(".");
    next[key] = chooseRepresentativeValue(child, fullPath);
  }
  return next;
}

function chooseRepresentativeValue(node: JsonSchemaNode, path: string): unknown {
  const values = inferValueCandidates(node);
  if (values.length > 0) {
    if (looksSensitiveKey(path.split(".").at(-1) ?? "")) {
      return "plain-text-secret";
    }
    return values[0];
  }

  if (isArrayNode(node)) {
    return [chooseRepresentativeValue(node.items ?? {}, `${path}.0`)];
  }

  if (isObjectNode(node)) {
    return buildSyntheticConfig(node, toSegments(path));
  }

  const type = inferNodeType(node);
  switch (type) {
    case "string":
      return looksSensitiveKey(path.split(".").at(-1) ?? "") ? "plain-text-secret" : "value";
    case "integer":
    case "number":
      return 1;
    case "boolean":
      return true;
    default:
      return "value";
  }
}

function inferValueCandidates(node: JsonSchemaNode): CompletionPrimitive[] {
  if (node.const !== undefined && isPrimitive(node.const)) {
    return [node.const];
  }
  if (Array.isArray(node.enum)) {
    return node.enum.filter((value): value is CompletionPrimitive => isPrimitive(value));
  }
  if (isPrimitive(node.default)) {
    return [node.default];
  }
  if (Array.isArray(node.examples)) {
    const examples = node.examples.filter((value): value is CompletionPrimitive => isPrimitive(value));
    if (examples.length > 0) {
      return examples;
    }
  }
  const type = inferNodeType(node);
  switch (type) {
    case "boolean":
      return [true, false];
    default:
      return [];
  }
}

function inferNodeType(node: JsonSchemaNode): string | null {
  const direct = normalizeType(node.type);
  if (direct) {
    return direct;
  }
  for (const candidate of [...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])]) {
    const nested = inferNodeType(candidate);
    if (nested) {
      return nested;
    }
  }
  if (node.properties || typeof node.additionalProperties === "object") {
    return "object";
  }
  if (node.items) {
    return "array";
  }
  return null;
}

function normalizeType(type: string | string[] | undefined): string | null {
  if (Array.isArray(type)) {
    return type.find((entry) => entry !== "null") ?? null;
  }
  return type ?? null;
}

function wrapAsJson(body: string): string {
  return `{\n${indentBlock(body, 1)}\n}`;
}

function buildNestedStructure(
  segments: string[],
  marker: string,
  mode: "key" | "value",
  keyName?: string,
): string {
  if (segments.length === 0) {
    return buildLeaf(marker, mode, keyName);
  }

  const [head, ...tail] = segments;
  if (isArrayIndexSegment(head)) {
    const nested = buildNestedStructure(tail, marker, mode, keyName);
    const value =
      tail.length === 0
        ? `{\n${indentBlock(nested, 1)}\n}`
        : isArrayIndexSegment(tail[0])
          ? nested
          : `{\n${indentBlock(nested, 1)}\n}`;
    return `[\n${indentBlock(value, 1)}\n]`;
  }
  const nested = buildNestedStructure(tail, marker, mode, keyName);
  const value =
    tail.length === 0
      ? `{\n${indentBlock(nested, 1)}\n}`
      : isArrayIndexSegment(tail[0])
        ? nested
        : `{\n${indentBlock(nested, 1)}\n}`;
  return `"${head}": ${value}`;
}

function buildLeaf(marker: string, mode: "key" | "value", keyName?: string): string {
  switch (mode) {
    case "key":
      return marker;
    case "value":
      return `"${keyName}": ${marker}`;
    default:
      return marker;
  }
}

function collectProperties(node: JsonSchemaNode): Map<string, JsonSchemaNode> {
  const merged = new Map<string, JsonSchemaNode>();

  const direct = node.properties ?? {};
  for (const [key, value] of Object.entries(direct)) {
    if (isObjectNode(value)) {
      merged.set(key, value);
    }
  }

  for (const composed of [...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])]) {
    if (!isObjectNode(composed)) {
      continue;
    }
    for (const [key, value] of collectProperties(composed)) {
      if (!merged.has(key)) {
        merged.set(key, value);
      }
    }
  }

  return merged;
}

function resolveHint(
  hints: UiHintRecord,
  fullPath: string,
): { label?: string; help?: string } | undefined {
  return resolveUiHint(hints, fullPath);
}

function isArrayNode(node: JsonSchemaNode | boolean | undefined): node is JsonSchemaNode {
  return Boolean(
    isObjectNode(node) &&
    (inferNodeType(node) === "array" || node.items),
  );
}

function isObjectNode(node: JsonSchemaNode | boolean | undefined): node is JsonSchemaNode {
  return Boolean(node && typeof node === "object");
}

function isPrimitive(value: unknown): value is CompletionPrimitive {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function allowsStringLikeValue(node: JsonSchemaNode): boolean {
  const type = inferNodeType(node);
  return type === "string" || type === null;
}

function looksSensitiveKey(key: string): boolean {
  return /(token|secret|password|api(?:_|-)?key|private(?:_|-)?key|access(?:_|-)?key)/i.test(key);
}

function normalizePath(value: string): string {
  return value
    .trim()
    .replace(/\[(\d+|\*)\]/g, ".$1")
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join(".");
}

function toSegments(path: string): string[] {
  return normalizePath(path).split(".").filter(Boolean);
}

function isArrayIndexSegment(value: string | undefined): boolean {
  return Boolean(value && /^\d+$/.test(value));
}

function indentBlock(value: string, level: number): string {
  const prefix = "  ".repeat(level);
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}
