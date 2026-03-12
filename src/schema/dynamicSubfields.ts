import type {
  CompletionPrimitive,
  DynamicSubfieldCatalog,
  DynamicSubfieldEntry,
  DynamicValueHints,
  DynamicValueType,
  PluginHintEntry,
  ResolvedDynamicSubfieldEntry,
} from "./types";
import { resolveUiHint } from "./uiHints";

type JsonSchemaNode = {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  additionalProperties?: boolean | JsonSchemaNode;
  items?: JsonSchemaNode;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
  description?: string;
  title?: string;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  examples?: unknown[];
};

type UiHintRecord = Record<string, { label?: string; help?: string }>;
const DISCOVERY_HINT_MARKER = "__openclawAssistiveField";

export function buildDynamicSubfieldCatalog(
  schemaText: string,
  uiHintsText: string,
  pluginEntries: readonly PluginHintEntry[],
): DynamicSubfieldCatalog {
  const schema = parseJson<JsonSchemaNode>(schemaText) ?? {};
  const hints = parseJson<UiHintRecord>(uiHintsText) ?? {};

  const fieldsByPattern = new Map<string, DynamicSubfieldEntry[]>();
  const rootSections = new Set<string>();

  walkSchema(schema, [], hints, fieldsByPattern, rootSections);
  mergeAssistiveHintEntries(hints, fieldsByPattern);
  mergePluginEntries(pluginEntries, hints, fieldsByPattern);

  return {
    sections: [...rootSections].sort((a, b) => a.localeCompare(b)),
    fieldsByPattern,
  };
}

export function resolveDynamicSubfields(
  catalog: DynamicSubfieldCatalog,
  rawPath: string,
): DynamicSubfieldEntry[] {
  return resolveDynamicSubfieldsWithMatches(catalog, rawPath).map((resolution) => resolution.entry);
}

export function resolveDynamicSubfieldsWithMatches(
  catalog: DynamicSubfieldCatalog,
  rawPath: string,
): ResolvedDynamicSubfieldEntry[] {
  const path = normalizePath(rawPath);
  const pathSegments = path ? path.split(".") : [];
  const seen = new Map<string, ResolvedDynamicSubfieldEntry>();

  for (const [pattern, entries] of catalog.fieldsByPattern) {
    const patternSegments = pattern ? pattern.split(".") : [];
    if (!matchesPathPattern(patternSegments, pathSegments)) {
      continue;
    }
    const matchedByWildcard = patternSegments.includes("*");

    for (const entry of entries) {
      const candidate: ResolvedDynamicSubfieldEntry = {
        entry: cloneSubfieldEntry(entry),
        matchedPattern: pattern,
        matchedByWildcard,
      };
      const existing = seen.get(entry.key);
      if (!existing || compareResolution(candidate, existing) > 0) {
        seen.set(entry.key, candidate);
      }
    }
  }

  return [...seen.values()].sort((a, b) => a.entry.key.localeCompare(b.entry.key));
}

function walkSchema(
  node: JsonSchemaNode,
  pathSegments: string[],
  hints: UiHintRecord,
  fieldsByPattern: Map<string, DynamicSubfieldEntry[]>,
  rootSections: Set<string>,
): void {
  if (!node || typeof node !== "object") {
    return;
  }

  const properties = collectProperties(node);
  const objectPattern = pathSegments.join(".");

  for (const [key, propertyNode] of properties) {
    if (pathSegments.length === 0 && key !== "$schema") {
      rootSections.add(key);
    }

    const fullPath = [...pathSegments, key].join(".");
    const hint = resolveHint(hints, fullPath);
    const description = hint?.help ?? hint?.label ?? propertyNode.description ?? propertyNode.title;
    const snippet = inferSnippet(propertyNode);
    const valueHints = inferValueHints(propertyNode);

    addField(fieldsByPattern, objectPattern, {
      key,
      path: fullPath,
      description: description || undefined,
      source: "schema",
      snippet,
      valueHints,
    });

    walkSchema(propertyNode, [...pathSegments, key], hints, fieldsByPattern, rootSections);
  }

  if (isObjectSchema(node.additionalProperties)) {
    walkSchema(node.additionalProperties, [...pathSegments, "*"], hints, fieldsByPattern, rootSections);
  }

  if (isObjectSchema(node.items)) {
    walkSchema(node.items, [...pathSegments, "*"], hints, fieldsByPattern, rootSections);
  }
}

function collectProperties(node: JsonSchemaNode): Map<string, JsonSchemaNode> {
  const merged = new Map<string, JsonSchemaNode>();

  const direct = node.properties ?? {};
  for (const [key, value] of Object.entries(direct)) {
    if (isObjectSchema(value)) {
      merged.set(key, value);
    }
  }

  for (const composed of [...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])]) {
    if (!isObjectSchema(composed)) {
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

function mergePluginEntries(
  entries: readonly PluginHintEntry[],
  hints: UiHintRecord,
  fieldsByPattern: Map<string, DynamicSubfieldEntry[]>,
): void {
  for (const entry of entries) {
    const pattern = normalizePath(entry.path);
    for (const [fieldKey, fieldHint] of Object.entries(entry.properties)) {
      const cleanKey = fieldKey.trim();
      if (!cleanKey) {
        continue;
      }
      const fullPath = [pattern, cleanKey].filter(Boolean).join(".");
      const hint = resolveHint(hints, fullPath);
      addField(fieldsByPattern, pattern, {
        key: cleanKey,
        path: fullPath,
        description: fieldHint.description ?? hint?.help ?? hint?.label,
        source: "plugin",
        snippet: fieldHint.snippet ?? inferSnippetFromType(fieldHint.type),
        valueHints: compactValueHints({
          valueType: asDynamicValueType(fieldHint.type),
          enumValues: fieldHint.enumValues ? [...fieldHint.enumValues] : undefined,
          examples: fieldHint.examples ? [...fieldHint.examples] : undefined,
          defaultValue: fieldHint.defaultValue,
        }),
      });
    }
  }
}

function mergeAssistiveHintEntries(
  hints: UiHintRecord,
  fieldsByPattern: Map<string, DynamicSubfieldEntry[]>,
): void {
  const hintPaths = new Set(
    Object.entries(hints)
      .filter(([, hint]) => isAssistiveHint(hint))
      .map(([path]) => normalizePath(path))
      .filter(Boolean),
  );

  for (const fullPath of hintPaths) {
    const segments = fullPath.split(".");
    if (segments.length === 0) {
      continue;
    }

    const key = segments.at(-1);
    const pattern = segments.slice(0, -1).join(".");
    if (!key || key === "*") {
      continue;
    }

    const hint = resolveHint(hints, fullPath);
    addField(fieldsByPattern, pattern, {
      key,
      path: fullPath,
      description: hint?.help ?? hint?.label,
      source: "plugin",
      snippet: [...hintPaths].some((candidate) => candidate.startsWith(`${fullPath}.`))
        ? "{\n  $1\n}"
        : undefined,
    });
  }
}

function addField(
  fieldsByPattern: Map<string, DynamicSubfieldEntry[]>,
  pattern: string,
  candidate: DynamicSubfieldEntry,
): void {
  const current = fieldsByPattern.get(pattern) ?? [];
  const existingIndex = current.findIndex((entry) => entry.key === candidate.key);

  if (existingIndex === -1) {
    current.push(candidate);
    fieldsByPattern.set(pattern, current);
    return;
  }

  const existing = current[existingIndex];
  current.splice(existingIndex, 1, mergeEntry(existing, candidate));
  fieldsByPattern.set(pattern, current);
}

function resolveHint(
  hints: UiHintRecord,
  fullPath: string,
): { label?: string; help?: string } | undefined {
  return resolveUiHint(hints, fullPath);
}

function matchesPathPattern(patternSegments: string[], pathSegments: string[]): boolean {
  if (patternSegments.length !== pathSegments.length) {
    return false;
  }
  for (let index = 0; index < patternSegments.length; index += 1) {
    const expected = patternSegments[index];
    const actual = pathSegments[index];
    if (expected !== "*" && expected !== actual) {
      return false;
    }
  }
  return true;
}

function inferSnippet(node: JsonSchemaNode): string | undefined {
  return inferSnippetFromType(inferValueType(node));
}

function inferSnippetFromType(type: string | undefined): string | undefined {
  switch (type) {
    case "object":
      return "{\n  $1\n}";
    case "array":
      return "[\n  $1\n]";
    case "string":
      return '"${1:value}"';
    case "integer":
    case "number":
      return "${1:0}";
    case "boolean":
      return "${1|true,false|}";
    default:
      return undefined;
  }
}

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
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

function isObjectSchema(value: unknown): value is JsonSchemaNode {
  return Boolean(value && typeof value === "object");
}

function isAssistiveHint(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Reflect.get(value as object, DISCOVERY_HINT_MARKER) === true,
  );
}

function compareResolution(
  left: ResolvedDynamicSubfieldEntry,
  right: ResolvedDynamicSubfieldEntry,
): number {
  const sourceOrder = sourceRank(left.entry.source) - sourceRank(right.entry.source);
  if (sourceOrder !== 0) {
    return sourceOrder;
  }

  const specificityOrder = patternSpecificity(left.matchedPattern) - patternSpecificity(right.matchedPattern);
  if (specificityOrder !== 0) {
    return specificityOrder;
  }

  if (left.matchedByWildcard !== right.matchedByWildcard) {
    return left.matchedByWildcard ? -1 : 1;
  }

  return 0;
}

function sourceRank(source: "schema" | "plugin"): number {
  return source === "plugin" ? 2 : 1;
}

function patternSpecificity(pattern: string): number {
  if (!pattern) {
    return 0;
  }
  return pattern.split(".").filter((segment) => segment && segment !== "*").length;
}

function cloneSubfieldEntry(entry: DynamicSubfieldEntry): DynamicSubfieldEntry {
  return {
    ...entry,
    valueHints: cloneValueHints(entry.valueHints),
  };
}

function mergeEntry(existing: DynamicSubfieldEntry, candidate: DynamicSubfieldEntry): DynamicSubfieldEntry {
  if (existing.source === "plugin" && candidate.source === "schema") {
    return cloneSubfieldEntry(existing);
  }

  if (existing.source === "schema" && candidate.source === "plugin") {
    return {
      ...cloneSubfieldEntry(existing),
      ...cloneSubfieldEntry(candidate),
      source: "plugin",
      description: candidate.description ?? existing.description,
      snippet: candidate.snippet ?? existing.snippet,
      valueHints: mergeValueHints(existing.valueHints, candidate.valueHints),
    };
  }

  if (existing.source === "plugin" && candidate.source === "plugin") {
    return {
      ...cloneSubfieldEntry(existing),
      ...cloneSubfieldEntry(candidate),
      source: "plugin",
      description: candidate.description ?? existing.description,
      snippet: candidate.snippet ?? existing.snippet,
      valueHints: mergeValueHints(existing.valueHints, candidate.valueHints),
    };
  }

  return cloneSubfieldEntry(existing);
}

function mergeValueHints(
  existing: DynamicValueHints | undefined,
  candidate: DynamicValueHints | undefined,
): DynamicValueHints | undefined {
  if (!existing && !candidate) {
    return undefined;
  }
  return compactValueHints({
    valueType: candidate?.valueType ?? existing?.valueType,
    enumValues: candidate?.enumValues ? [...candidate.enumValues] : existing?.enumValues ? [...existing.enumValues] : undefined,
    examples: candidate?.examples ? [...candidate.examples] : existing?.examples ? [...existing.examples] : undefined,
    defaultValue: candidate?.defaultValue ?? existing?.defaultValue,
  });
}

function cloneValueHints(valueHints: DynamicValueHints | undefined): DynamicValueHints | undefined {
  if (!valueHints) {
    return undefined;
  }
  return {
    valueType: valueHints.valueType,
    enumValues: valueHints.enumValues ? [...valueHints.enumValues] : undefined,
    examples: valueHints.examples ? [...valueHints.examples] : undefined,
    defaultValue: valueHints.defaultValue,
  };
}

function compactValueHints(valueHints: DynamicValueHints): DynamicValueHints | undefined {
  const compact: DynamicValueHints = {};
  if (valueHints.valueType) {
    compact.valueType = valueHints.valueType;
  }
  if (valueHints.enumValues && valueHints.enumValues.length > 0) {
    compact.enumValues = [...valueHints.enumValues];
  }
  if (valueHints.examples && valueHints.examples.length > 0) {
    compact.examples = [...valueHints.examples];
  }
  if (valueHints.defaultValue !== undefined) {
    compact.defaultValue = valueHints.defaultValue;
  }

  return hasValueHints(compact) ? compact : undefined;
}

function hasValueHints(valueHints: DynamicValueHints): boolean {
  return Boolean(
    valueHints.valueType ||
      (valueHints.enumValues && valueHints.enumValues.length > 0) ||
      (valueHints.examples && valueHints.examples.length > 0) ||
      valueHints.defaultValue !== undefined,
  );
}

function inferValueHints(node: JsonSchemaNode): DynamicValueHints | undefined {
  return compactValueHints({
    valueType: inferValueType(node),
    enumValues: collectEnumValues(node),
    examples: collectExamples(node),
    defaultValue: inferDefaultValue(node),
  });
}

function inferValueType(node: JsonSchemaNode): DynamicValueType | undefined {
  const direct = asDynamicValueType(node.type);
  if (direct) {
    return direct;
  }

  for (const composed of [...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])]) {
    if (!isObjectSchema(composed)) {
      continue;
    }
    const nested = inferValueType(composed);
    if (nested) {
      return nested;
    }
  }

  const fromConst = toCompletionPrimitive(node.const);
  if (fromConst !== undefined) {
    return inferValueTypeFromPrimitive(fromConst);
  }

  const fromEnum = collectEnumValues(node)?.[0];
  if (fromEnum !== undefined) {
    return inferValueTypeFromPrimitive(fromEnum);
  }

  return undefined;
}

function inferValueTypeFromPrimitive(value: CompletionPrimitive): DynamicValueType | undefined {
  if (value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return "string";
  }
  if (typeof value === "boolean") {
    return "boolean";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  return undefined;
}

function asDynamicValueType(value: unknown): DynamicValueType | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const resolved = asDynamicValueType(entry);
      if (resolved) {
        return resolved;
      }
    }
    return undefined;
  }

  if (
    value === "string" ||
    value === "number" ||
    value === "integer" ||
    value === "boolean" ||
    value === "object" ||
    value === "array"
  ) {
    return value;
  }

  return undefined;
}

function collectEnumValues(node: JsonSchemaNode): CompletionPrimitive[] | undefined {
  const values: CompletionPrimitive[] = [];
  const seen = new Set<string>();

  if (Array.isArray(node.enum)) {
    appendPrimitiveValues(values, seen, node.enum);
  }
  appendPrimitiveValue(values, seen, node.const);

  for (const composed of [...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])]) {
    if (!isObjectSchema(composed)) {
      continue;
    }
    const nested = collectEnumValues(composed);
    if (nested) {
      appendPrimitiveValues(values, seen, nested);
    }
  }

  return values.length > 0 ? values : undefined;
}

function collectExamples(node: JsonSchemaNode): CompletionPrimitive[] | undefined {
  const values: CompletionPrimitive[] = [];
  const seen = new Set<string>();

  if (Array.isArray(node.examples)) {
    appendPrimitiveValues(values, seen, node.examples);
  }

  for (const composed of [...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])]) {
    if (!isObjectSchema(composed)) {
      continue;
    }
    const nested = collectExamples(composed);
    if (nested) {
      appendPrimitiveValues(values, seen, nested);
    }
  }

  return values.length > 0 ? values : undefined;
}

function inferDefaultValue(node: JsonSchemaNode): CompletionPrimitive | undefined {
  const direct = toCompletionPrimitive(node.default);
  if (direct !== undefined) {
    return direct;
  }

  for (const composed of [...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])]) {
    if (!isObjectSchema(composed)) {
      continue;
    }
    const nested = inferDefaultValue(composed);
    if (nested !== undefined) {
      return nested;
    }
  }

  return undefined;
}

function appendPrimitiveValues(
  target: CompletionPrimitive[],
  seen: Set<string>,
  values: readonly unknown[],
): void {
  for (const value of values) {
    appendPrimitiveValue(target, seen, value);
  }
}

function appendPrimitiveValue(
  target: CompletionPrimitive[],
  seen: Set<string>,
  value: unknown,
): void {
  const primitive = toCompletionPrimitive(value);
  if (primitive === undefined) {
    return;
  }

  const fingerprint = `${typeof primitive}:${JSON.stringify(primitive)}`;
  if (seen.has(fingerprint)) {
    return;
  }

  seen.add(fingerprint);
  target.push(primitive);
}

function toCompletionPrimitive(value: unknown): CompletionPrimitive | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value === null) {
    return null;
  }
  return undefined;
}
