import { createHash } from "node:crypto";
import type { PluginDiscoveryResult } from "./pluginDiscovery";

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stableValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function digestJson(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

export function computePluginDiscoveryFingerprint(discovery: PluginDiscoveryResult): string {
  return digestJson({
    status: {
      source: discovery.status.source,
      authoritative: discovery.status.authoritative,
    },
    plugins: discovery.plugins.map((plugin) => ({
      id: plugin.id,
      version: plugin.version ?? "",
      kind: plugin.kind ?? "",
      source: plugin.source ?? "",
      origin: plugin.origin ?? "",
      manifestPath: plugin.manifestPath ?? "",
      pluginRoot: plugin.pluginRoot ?? "",
      declaredChannels: plugin.declaredChannels ?? [],
      declaredProviders: plugin.declaredProviders ?? [],
      declaredSkills: plugin.declaredSkills ?? [],
      configSchemaHash: plugin.configJsonSchema ? digestJson(plugin.configJsonSchema) : "",
      configUiHintsHash: plugin.configUiHints ? digestJson(plugin.configUiHints) : "",
    })),
  });
}

export function computeResolvedSnapshotCacheKey(params: {
  openclawVersion: string;
  pluginFingerprint: string;
  sourceIdentity: string;
  preferredSource: string;
}): string {
  return digestJson(params);
}
