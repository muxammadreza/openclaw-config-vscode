import * as vscode from "vscode";
import {
  findNodeAtLocation,
  findNodeAtOffset,
  getNodePath,
  parseTree,
  type Node,
} from "jsonc-parser";
import { parseIssuePath } from "../issuePath";

export function extractUnknownKey(message: string): string | null {
  const patterns = [
    /Unrecognized key:\s*"([^"]+)"/i,
    /Property\s+"([^"]+)"\s+is not allowed/i,
    /Property\s+'([^']+)'\s+is not allowed/i,
    /Property\s+([A-Za-z0-9_.-]+)\s+is not allowed/i,
    /additional propert(?:y|ies)[^"']*["']([^"']+)["']/i,
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    const key = match?.[1]?.trim();
    if (key) {
      return key;
    }
  }

  return null;
}

export function extractBindingIndex(path: string): number | null {
  const match = path.match(/^bindings\.(\d+)\./);
  if (!match) {
    return null;
  }
  return Number(match[1]);
}

export function looksSensitivePath(path: string): boolean {
  return /(token|api(?:_|-)?key|secret|password|private(?:_|-)?key|access(?:_|-)?key)/i.test(path);
}

export function toEnvVarName(path: string): string {
  const segments = path
    .split(".")
    .filter((segment) => segment && !/^\d+$/.test(segment))
    .map((segment) =>
      segment
        .replace(/[^a-zA-Z0-9]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "")
        .toUpperCase(),
    )
    .filter(Boolean);

  const suffix = segments.slice(-4).join("_");
  if (!suffix) {
    return "OPENCLAW_SECRET";
  }
  return `OPENCLAW_${suffix}`;
}

export function resolvePathFromDiagnosticCode(code: vscode.Diagnostic["code"]): string | null {
  if (typeof code === "string") {
    return code.trim() || null;
  }
  if (code && typeof code === "object" && "value" in code) {
    const value = code.value;
    if (typeof value === "string") {
      return value.trim() || null;
    }
  }
  return null;
}

export function appendPath(basePath: string, key: string): string {
  return `${basePath}.${key}`;
}

export function findPropertyPathFromRange(
  document: vscode.TextDocument,
  range: vscode.Range,
): string | null {
  const text = document.getText();
  const root = parseTree(text);
  if (!root) {
    return null;
  }

  const offset = document.offsetAt(range.start);
  const node = findNodeAtOffset(root, offset, true);
  const propertyNode = climbToPropertyNode(node);
  if (!propertyNode) {
    return null;
  }

  const keyNode = propertyNode.children?.[0];
  if (!keyNode || typeof keyNode.value !== "string") {
    return null;
  }

  const parent = propertyNode.parent;
  if (!parent) {
    return null;
  }
  const parentPath = getNodePath(parent);
  const pathSegments = [...parentPath, keyNode.value];
  return pathSegments.join(".");
}

export function fullDocumentRange(document: vscode.TextDocument): vscode.Range {
  if (document.lineCount === 0) {
    return new vscode.Range(0, 0, 0, 0);
  }
  const lastLine = document.lineAt(document.lineCount - 1);
  return new vscode.Range(0, 0, document.lineCount - 1, lastLine.text.length);
}

export function pathExistsInDocument(text: string, path: string): boolean {
  const root = parseTree(text);
  if (!root) {
    return false;
  }
  const node = findNodeAtLocation(root, parseIssuePath(path));
  return Boolean(node);
}

function climbToPropertyNode(node: Node | undefined): Node | null {
  let current = node;
  while (current) {
    if (current.type === "property") {
      return current;
    }
    current = current.parent;
  }
  return null;
}
