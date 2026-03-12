import { findNodeAtOffset, getNodePath, parseTree, type Node } from "jsonc-parser";
import { resolveDynamicSubfields } from "./dynamicSubfields";
import type { DynamicSubfieldCatalog, SchemaLookupResult } from "./types";

type UiHintRecord = Record<string, { label?: string; help?: string }>;

export function findPathAtOffset(text: string, offset: number): string | null {
  const root = parseTree(text);
  if (!root) {
    return null;
  }

  const node = findNodeAtOffset(root, offset, true);
  if (!node) {
    return null;
  }

  const propertyNode = findClosestPropertyNode(node);
  if (propertyNode) {
    const keyNode = propertyNode.children?.[0];
    if (keyNode && typeof keyNode.value === "string" && propertyNode.parent) {
      const parentPath = getNodePath(propertyNode.parent);
      return normalizePath([...parentPath, keyNode.value].join("."));
    }
  }

  const parentPath = getNodePath(node);
  if (parentPath.length > 0) {
    return normalizePath(parentPath.join("."));
  }
  return "";
}

export function buildFieldExplainMarkdown(
  path: string,
  catalog: DynamicSubfieldCatalog,
  uiHintsText: string,
  lookup?: SchemaLookupResult | null,
): string {
  const normalized = normalizePath(path);
  const hints = parseUiHints(uiHintsText);
  const hint = lookup?.hint ?? resolveHint(hints, normalized);
  const subfields = lookup?.children.map((child) => ({
    key: child.key,
    description: child.hint?.help ?? child.hint?.label ?? describeLookupChild(child.type),
  })) ?? resolveDynamicSubfields(catalog, normalized);

  const lines: string[] = [];
  lines.push(`### ${(hint?.label ?? normalized) || "Root Config"}`);

  if (hint?.help) {
    lines.push("");
    lines.push(hint.help);
  }

  if (subfields.length > 0) {
    lines.push("");
    lines.push("Allowed subfields:");
    for (const entry of subfields.slice(0, 20)) {
      const description = entry.description ? ` - ${entry.description}` : "";
      lines.push(`- \`${entry.key}\`${description}`);
    }
  }

  if (subfields.length === 0) {
    lines.push("");
    lines.push("No further subfields detected for this path.");
  }

  return lines.join("\n");
}

function describeLookupChild(type: string | string[] | undefined): string | undefined {
  if (!type) {
    return undefined;
  }
  return Array.isArray(type) ? type.join(" | ") : type;
}

function findClosestPropertyNode(node: Node): Node | null {
  let current: Node | undefined = node;
  while (current) {
    if (current.type === "property") {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function parseUiHints(raw: string): UiHintRecord {
  try {
    return JSON.parse(raw) as UiHintRecord;
  } catch {
    return {};
  }
}

function resolveHint(
  hints: UiHintRecord,
  path: string,
): { label?: string; help?: string } | undefined {
  if (!path) {
    return undefined;
  }
  if (hints[path]) {
    return hints[path];
  }
  const wildcard = path.replace(/\.\d+(\.|$)/g, ".*$1");
  return hints[wildcard];
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
