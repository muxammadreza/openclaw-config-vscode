import { applyEdits, modify, parse } from "jsonc-parser";
import { OPENCLAW_SCHEMA_URI } from "../../schema/constants";
import { parseIssuePath } from "../issuePath";
import { toEnvVarName } from "./secrets";
import { FORMAT_OPTIONS, type OpenClawQuickFixPayload } from "./types";

export function isQuickFixPayload(value: unknown): value is OpenClawQuickFixPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<OpenClawQuickFixPayload>;
  if (
    candidate.kind !== "setSchema" &&
    candidate.kind !== "removeUnknownKey" &&
    candidate.kind !== "removeDuplicateAgentDir" &&
    candidate.kind !== "removeInvalidBinding" &&
    candidate.kind !== "replaceSecretWithEnvRef"
  ) {
    return false;
  }
  return typeof candidate.uri === "string" && candidate.uri.length > 0;
}

export function computeQuickFixText(text: string, payload: OpenClawQuickFixPayload): string | null {
  switch (payload.kind) {
    case "setSchema": {
      const edits = modify(text, ["$schema"], OPENCLAW_SCHEMA_URI, FORMAT_OPTIONS);
      return edits.length > 0 ? applyEdits(text, edits) : text;
    }
    case "removeUnknownKey": {
      if (!payload.path) {
        return null;
      }
      const edits = modify(text, parseIssuePath(payload.path), undefined, FORMAT_OPTIONS);
      return edits.length > 0 ? applyEdits(text, edits) : text;
    }
    case "removeDuplicateAgentDir": {
      const paths = resolveDuplicateAgentDirPaths(text, payload.diagnosticMessage ?? "");
      if (paths.length === 0) {
        return null;
      }
      let nextText = text;
      for (const path of paths) {
        const edits = modify(nextText, parseIssuePath(path), undefined, FORMAT_OPTIONS);
        if (edits.length === 0) {
          continue;
        }
        nextText = applyEdits(nextText, edits);
      }
      return nextText;
    }
    case "removeInvalidBinding": {
      if (!payload.path) {
        return null;
      }
      const edits = modify(text, parseIssuePath(payload.path), undefined, FORMAT_OPTIONS);
      return edits.length > 0 ? applyEdits(text, edits) : text;
    }
    case "replaceSecretWithEnvRef": {
      if (!payload.path) {
        return null;
      }
      const envReference = `\${env:${toEnvVarName(payload.path)}}`;
      const edits = modify(text, parseIssuePath(payload.path), envReference, FORMAT_OPTIONS);
      return edits.length > 0 ? applyEdits(text, edits) : text;
    }
    default:
      return null;
  }
}

export function resolveDuplicateAgentDirPaths(text: string, diagnosticMessage: string): string[] {
  const parsed = parse(text);
  const agents = (parsed as { agents?: { list?: Array<{ id?: unknown; agentDir?: unknown }> } }).agents;
  const list = Array.isArray(agents?.list) ? agents.list : [];

  const lineMatches = [...diagnosticMessage.matchAll(/: ([^\n]+)/g)];
  const duplicateIds = new Set<string>();
  for (const match of lineMatches) {
    const ids = [...(match[1] ?? "").matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
    for (const id of ids.slice(1)) {
      duplicateIds.add(id);
    }
  }

  if (duplicateIds.size === 0) {
    return [];
  }

  const paths: string[] = [];
  for (const [index, entry] of list.entries()) {
    const id = typeof entry?.id === "string" ? entry.id : "";
    if (!duplicateIds.has(id)) {
      continue;
    }
    if (typeof entry?.agentDir !== "string" || !entry.agentDir) {
      continue;
    }
    paths.push(`agents.list.${index}.agentDir`);
  }

  return paths;
}
