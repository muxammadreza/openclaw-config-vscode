import type { PluginDiscoveryResult } from "../schema/pluginDiscovery";
import type { DiscoveredPlugin, PluginValidationIssue } from "../schema/types";

type PluginSlotName = "memory" | "contextEngine";

const CONTEXT_ENGINE_BUILTINS = new Set(["legacy"]);
const MEMORY_BUILTINS = new Set(["none"]);
const CHANNEL_BUILTINS = new Set(["defaults"]);

export function evaluatePluginValidationIssues(
  config: unknown,
  discovery: Pick<PluginDiscoveryResult, "plugins" | "channelSurfaces" | "providerSurfaces">,
): PluginValidationIssue[] {
  if (!config || typeof config !== "object") {
    return [];
  }

  const issues: PluginValidationIssue[] = [];
  const pluginMap = new Map(discovery.plugins.map((plugin) => [plugin.id, plugin]));
  const channelIds = new Set(discovery.channelSurfaces.map((surface) => surface.id));
  const typedConfig = config as Record<string, unknown>;
  const pluginsConfig = asRecord(typedConfig.plugins);
  if (pluginsConfig) {
    issues.push(...checkPluginEntries(asRecord(pluginsConfig.entries), pluginMap));
    issues.push(...checkPluginIdList("allow", asStringArray(pluginsConfig.allow), pluginMap));
    issues.push(...checkPluginIdList("deny", asStringArray(pluginsConfig.deny), pluginMap));
    issues.push(...checkPluginSlot("memory", asRecord(pluginsConfig.slots), pluginMap));
    issues.push(...checkPluginSlot("contextEngine", asRecord(pluginsConfig.slots), pluginMap));
  }

  issues.push(...checkChannels(asRecord(typedConfig.channels), channelIds));
  return issues;
}

function checkPluginEntries(
  entries: Record<string, unknown> | null,
  pluginMap: Map<string, DiscoveredPlugin>,
): PluginValidationIssue[] {
  if (!entries) {
    return [];
  }

  const issues: PluginValidationIssue[] = [];
  for (const [pluginId, entryValue] of Object.entries(entries)) {
    const entry = asRecord(entryValue);
    const discovered = pluginMap.get(pluginId);
    if (!discovered) {
      issues.push({
        code: "plugin-entry-missing",
        path: `plugins.entries.${pluginId}`,
        message: `Plugin entry references an undiscovered plugin "${pluginId}".`,
        severity: "warning",
      });
      continue;
    }

    const configValue = asRecord(entry?.config);
    if (
      discovered.enabled === false &&
      configValue &&
      Object.keys(configValue).length > 0
    ) {
      issues.push({
        code: "plugin-disabled-config",
        path: `plugins.entries.${pluginId}.config`,
        message: `Plugin "${pluginId}" is currently disabled locally but still has config in openclaw.json.`,
        severity: "warning",
      });
    }
  }

  return issues;
}

function checkPluginIdList(
  key: "allow" | "deny",
  values: string[],
  pluginMap: Map<string, DiscoveredPlugin>,
): PluginValidationIssue[] {
  const issues: PluginValidationIssue[] = [];
  const code = key === "allow" ? "plugin-allow-missing" : "plugin-deny-missing";

  for (const [index, pluginId] of values.entries()) {
    if (pluginMap.has(pluginId)) {
      continue;
    }
    issues.push({
      code,
      path: `plugins.${key}.${index}`,
      message: `Plugin "${pluginId}" is not installed or discoverable on this machine.`,
      severity: "error",
    });
  }

  return issues;
}

function checkPluginSlot(
  slotName: PluginSlotName,
  slots: Record<string, unknown> | null,
  pluginMap: Map<string, DiscoveredPlugin>,
): PluginValidationIssue[] {
  const value = getOptionalString(slots?.[slotName]);
  if (!value) {
    return [];
  }

  if (slotName === "memory" && MEMORY_BUILTINS.has(value)) {
    return [];
  }
  if (slotName === "contextEngine" && CONTEXT_ENGINE_BUILTINS.has(value)) {
    return [];
  }
  if (pluginMap.has(value)) {
    return [];
  }

  return [
    {
      code: slotName === "memory"
        ? "plugin-slot-memory-missing"
        : "plugin-slot-context-engine-missing",
      path: `plugins.slots.${slotName}`,
      message: `Plugin slot "${slotName}" references undiscovered plugin "${value}".`,
      severity: "error",
    },
  ];
}

function checkChannels(
  channels: Record<string, unknown> | null,
  discoveredChannelIds: Set<string>,
): PluginValidationIssue[] {
  if (!channels || discoveredChannelIds.size === 0) {
    return [];
  }

  const issues: PluginValidationIssue[] = [];
  for (const channelId of Object.keys(channels)) {
    if (CHANNEL_BUILTINS.has(channelId) || discoveredChannelIds.has(channelId)) {
      continue;
    }
    issues.push({
      code: "channel-entry-missing",
      path: `channels.${channelId}`,
      message: `Configured channel "${channelId}" is not discoverable from the locally installed plugin set.`,
      severity: "warning",
    });
  }
  return issues;
}

function getOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((entry) => getOptionalString(entry))
        .filter((entry): entry is string => Boolean(entry))
    : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
