import type { PluginDiscoveryResult } from "./pluginDiscovery";
import type {
  DiscoveredChannelSurface,
  DiscoveredPlugin,
  DiscoveredPluginSurface,
  DiscoveredProviderSurface,
} from "./types";

type JsonSchemaNode = Record<string, unknown>;
type UiHintRecord = Record<string, Record<string, unknown>>;
const DISCOVERY_HINT_MARKER = "__openclawAssistiveField";

export type PluginSchemaOverlay = {
  schemaText: string;
  uiHintsText: string;
};

export function applyPluginOverlays(
  schemaText: string,
  uiHintsText: string,
  discovery: PluginDiscoveryResult,
): PluginSchemaOverlay {
  const schema = parseRecord(schemaText);
  const uiHints = parseUiHints(uiHintsText);

  const schemaWithPluginIds = applyPluginIdConstraints(schema, discovery.plugins);
  const schemaWithPluginEntries = applyPluginEntrySurfaces(
    schemaWithPluginIds,
    discovery.pluginSurfaces.filter(isSchemaBacked),
  );
  const schemaWithChannels = applyChannelSurfaces(
    schemaWithPluginEntries,
    discovery.channelSurfaces.filter(isSchemaBacked),
  );
  const schemaWithProviders = applyProviderSurfaces(
    schemaWithChannels,
    discovery.providerSurfaces.filter(isSchemaBacked),
  );

  const hintsWithPluginEntries = applyPluginHints(uiHints, discovery.plugins, discovery.pluginSurfaces);
  const hintsWithChannels = applyChannelHints(hintsWithPluginEntries, discovery.channelSurfaces);
  const hintsWithProviders = applyProviderHints(hintsWithChannels, discovery.providerSurfaces);

  return {
    schemaText: JSON.stringify(schemaWithProviders, null, 2),
    uiHintsText: JSON.stringify(hintsWithProviders, null, 2),
  };
}

function applyPluginEntrySurfaces(
  schema: JsonSchemaNode,
  surfaces: readonly DiscoveredPluginSurface[],
): JsonSchemaNode {
  if (surfaces.length === 0) {
    return cloneJson(schema);
  }

  const next = cloneJson(schema);
  const branch = resolveBranchSchema(next, ["plugins", "entries"]);
  if (!branch) {
    return next;
  }

  const entryProperties = ensureRecord(branch, "properties");
  const baseEntry = asRecord(branch.additionalProperties) ?? { type: "object" };

  for (const surface of surfaces) {
    const existingEntry = asRecord(entryProperties[surface.id]) ?? cloneJson(baseEntry);
    const entryProps = ensureRecord(existingEntry, "properties");
    const baseConfig = asRecord(entryProps.config) ?? { type: "object", additionalProperties: true };
    entryProps.config = mergeObjectSchema(baseConfig, surface.schema ?? {});
    entryProperties[surface.id] = existingEntry;
  }

  return next;
}

function applyChannelSurfaces(
  schema: JsonSchemaNode,
  surfaces: readonly DiscoveredChannelSurface[],
): JsonSchemaNode {
  return applySurfaceSchemas(schema, ["channels"], surfaces);
}

function applyProviderSurfaces(
  schema: JsonSchemaNode,
  surfaces: readonly DiscoveredProviderSurface[],
): JsonSchemaNode {
  return applySurfaceSchemas(schema, ["models", "providers"], surfaces);
}

function applySurfaceSchemas(
  schema: JsonSchemaNode,
  branchPath: readonly string[],
  surfaces: readonly { id: string; schema?: JsonSchemaNode }[],
): JsonSchemaNode {
  if (surfaces.length === 0) {
    return cloneJson(schema);
  }

  const next = cloneJson(schema);
  const branch = resolveBranchSchema(next, branchPath);
  if (!branch) {
    return next;
  }

  const entryProperties = ensureRecord(branch, "properties");
  const baseEntry = asRecord(branch.additionalProperties) ?? { type: "object" };

  for (const surface of surfaces) {
    const existing = asRecord(entryProperties[surface.id]) ?? cloneJson(baseEntry);
    entryProperties[surface.id] = mergeObjectSchema(existing, surface.schema ?? {});
  }

  return next;
}

function applyPluginHints(
  uiHints: UiHintRecord,
  plugins: readonly DiscoveredPlugin[],
  surfaces: readonly DiscoveredPluginSurface[],
): UiHintRecord {
  const next = cloneJson(uiHints);
  const surfaceMap = new Map(surfaces.map((surface) => [surface.id, surface]));

  for (const plugin of plugins) {
    const pluginId = plugin.id.trim();
    if (!pluginId) {
      continue;
    }
    const surface = surfaceMap.get(pluginId);
    const name = plugin.name?.trim() || surface?.label?.trim() || pluginId;
    const basePath = `plugins.entries.${pluginId}`;
    next[basePath] = {
      ...next[basePath],
      label: name,
      help: plugin.description?.trim()
        ? `${plugin.description.trim()} (plugin: ${pluginId})`
        : `Plugin entry for ${pluginId}.`,
    };
    next[`${basePath}.enabled`] = {
      ...next[`${basePath}.enabled`],
      label: `Enable ${name}`,
    };
    next[`${basePath}.config`] = {
      ...next[`${basePath}.config`],
      label: `${name} Config`,
      help: `Plugin-defined config payload for ${pluginId}.`,
    };

    for (const [relativePath, hint] of Object.entries(surface?.uiHints ?? plugin.configUiHints ?? {})) {
      const normalizedPath = relativePath.trim().replace(/^\./, "");
      if (!normalizedPath) {
        continue;
      }
      next[`${basePath}.config.${normalizedPath}`] = {
        ...next[`${basePath}.config.${normalizedPath}`],
        ...hint,
      };
    }

    if (surface?.confidence === "inferred") {
      markAssistivePaths(next, surface.assistivePaths);
    }
  }

  return next;
}

function applyChannelHints(
  uiHints: UiHintRecord,
  surfaces: readonly DiscoveredChannelSurface[],
): UiHintRecord {
  const next = cloneJson(uiHints);

  for (const surface of surfaces) {
    const basePath = `channels.${surface.id}`;
    next[basePath] = {
      ...next[basePath],
      label: surface.label?.trim() || surface.id,
      help: surface.description?.trim() || next[basePath]?.help,
    };

    for (const [relativePath, hint] of Object.entries(surface.uiHints ?? {})) {
      const normalizedPath = relativePath.trim().replace(/^\./, "");
      const targetPath = normalizedPath ? `${basePath}.${normalizedPath}` : basePath;
      next[targetPath] = {
        ...next[targetPath],
        ...hint,
      };
    }

    if (surface.confidence === "inferred") {
      markAssistivePaths(next, surface.assistivePaths);
    }
  }

  return next;
}

function applyProviderHints(
  uiHints: UiHintRecord,
  surfaces: readonly DiscoveredProviderSurface[],
): UiHintRecord {
  const next = cloneJson(uiHints);

  for (const surface of surfaces) {
    const basePath = `models.providers.${surface.id}`;
    next[basePath] = {
      ...next[basePath],
      label: surface.label?.trim() || surface.id,
      help: surface.description?.trim() || next[basePath]?.help,
    };

    for (const [relativePath, hint] of Object.entries(surface.uiHints ?? {})) {
      const normalizedPath = relativePath.trim().replace(/^\./, "");
      const targetPath = normalizedPath ? `${basePath}.${normalizedPath}` : basePath;
      next[targetPath] = {
        ...next[targetPath],
        ...hint,
      };
    }

    if (surface.confidence === "inferred") {
      markAssistivePaths(next, surface.assistivePaths);
    }
  }

  return next;
}

function applyPluginIdConstraints(
  schema: JsonSchemaNode,
  plugins: readonly DiscoveredPlugin[],
): JsonSchemaNode {
  const next = cloneJson(schema);
  const rootProperties = asRecord(next.properties);
  const pluginsSchema = asRecord(rootProperties?.plugins);
  const pluginProperties = asRecord(pluginsSchema?.properties);
  if (!pluginProperties) {
    return next;
  }

  const pluginIds = plugins
    .map((plugin) => plugin.id)
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  if (pluginIds.length === 0) {
    return next;
  }

  const allowSchema = asRecord(pluginProperties.allow);
  const denySchema = asRecord(pluginProperties.deny);
  const slotsSchema = ensureBranchSchema(pluginProperties, "slots");
  const slotProperties = ensureRecord(slotsSchema, "properties");

  if (allowSchema) {
    allowSchema.items = {
      type: "string",
      enum: pluginIds,
    };
  }
  if (denySchema) {
    denySchema.items = {
      type: "string",
      enum: pluginIds,
    };
  }

  const memoryIds = plugins
    .filter((plugin) => plugin.kind === "memory")
    .map((plugin) => plugin.id)
    .sort((left, right) => left.localeCompare(right));
  const contextEngineIds = plugins
    .filter((plugin) => plugin.kind === "context-engine")
    .map((plugin) => plugin.id)
    .sort((left, right) => left.localeCompare(right));

  if (slotProperties) {
    const memorySchema = ensureBranchSchema(slotProperties, "memory");
    memorySchema.type = "string";
    memorySchema.enum = memoryIds.length > 0 ? ["none", ...memoryIds] : ["none"];

    const contextSchema = ensureBranchSchema(slotProperties, "contextEngine");
    contextSchema.type = "string";
    contextSchema.enum =
      contextEngineIds.length > 0 ? ["legacy", ...contextEngineIds] : ["legacy"];
  }

  return next;
}

function resolveBranchSchema(
  schema: JsonSchemaNode,
  branchPath: readonly string[],
): JsonSchemaNode | null {
  let current: JsonSchemaNode | null = schema;
  for (const segment of branchPath) {
    const properties = asRecord(current?.properties);
    current = asRecord(properties?.[segment]);
    if (!current) {
      return null;
    }
  }
  return current;
}

function ensureBranchSchema(container: JsonSchemaNode, key: string): JsonSchemaNode {
  const next = asRecord(container[key]) ?? {};
  container[key] = next;
  return next;
}

function mergeObjectSchema(
  baseSchema: JsonSchemaNode | null,
  pluginSchema: JsonSchemaNode,
): JsonSchemaNode {
  return mergeSchemaNodes(baseSchema, pluginSchema);
}

function parseRecord(raw: string): JsonSchemaNode {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return asRecord(parsed) ?? {};
  } catch {
    return {};
  }
}

function parseUiHints(raw: string): UiHintRecord {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return (asRecord(parsed) as UiHintRecord) ?? {};
  } catch {
    return {};
  }
}

function mergeSchemaNodes(
  baseSchema: JsonSchemaNode | null,
  overlaySchema: JsonSchemaNode | null,
): JsonSchemaNode {
  if (!baseSchema) {
    return cloneJson(overlaySchema ?? {});
  }
  if (!overlaySchema || Object.keys(overlaySchema).length === 0) {
    return cloneJson(baseSchema);
  }

  const baseType = typeof baseSchema.type === "string" ? baseSchema.type : undefined;
  const overlayType = typeof overlaySchema.type === "string" ? overlaySchema.type : undefined;

  if (!overlayType && baseType) {
    const merged = cloneJson(baseSchema);
    for (const [key, value] of Object.entries(overlaySchema)) {
      if (key === "properties" || key === "required" || key === "additionalProperties") {
        continue;
      }
      merged[key] = cloneJson(value);
    }
    return merged;
  }

  if (baseType !== "object" || overlayType !== "object") {
    return cloneJson(overlaySchema);
  }

  const next = cloneJson(baseSchema);
  const nextProperties = ensureRecord(next, "properties");
  const overlayProperties = asRecord(overlaySchema.properties) ?? {};
  for (const [key, value] of Object.entries(overlayProperties)) {
    nextProperties[key] = mergeSchemaNodes(asRecord(nextProperties[key]), asRecord(value));
  }

  for (const [key, value] of Object.entries(overlaySchema)) {
    if (key === "properties" || key === "required") {
      continue;
    }
    if (key === "additionalProperties") {
      const baseAdditional = next.additionalProperties;
      if (isRecordLike(baseAdditional) && isRecordLike(value)) {
        next.additionalProperties = mergeSchemaNodes(
          asRecord(baseAdditional),
          asRecord(value),
        );
      } else {
        next.additionalProperties = cloneJson(value);
      }
      continue;
    }
    next[key] = cloneJson(value);
  }

  const baseRequired = Array.isArray(baseSchema.required) ? baseSchema.required : [];
  const overlayRequired = Array.isArray(overlaySchema.required) ? overlaySchema.required : [];
  const mergedRequired = [...new Set([...baseRequired, ...overlayRequired])];
  if (mergedRequired.length > 0) {
    next.required = mergedRequired;
  }

  return next;
}

function markAssistivePaths(
  uiHints: UiHintRecord,
  paths: readonly string[] | undefined,
): void {
  if (!paths || paths.length === 0) {
    return;
  }

  const expanded = new Set<string>();
  for (const rawPath of paths) {
    const normalized = normalizePath(rawPath);
    if (!normalized) {
      continue;
    }
    const segments = normalized.split(".");
    for (let index = 1; index <= segments.length; index += 1) {
      const partial = segments.slice(0, index).join(".");
      if (partial.endsWith(".*")) {
        continue;
      }
      expanded.add(partial);
    }
  }

  for (const discoveredPath of expanded) {
    uiHints[discoveredPath] = {
      ...uiHints[discoveredPath],
      [DISCOVERY_HINT_MARKER]: true,
    };
  }
}

function isSchemaBacked(
  surface: { confidence: string },
): boolean {
  return surface.confidence === "explicit" || surface.confidence === "derived";
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

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function ensureRecord(target: JsonSchemaNode, key: string): JsonSchemaNode {
  const existing = asRecord(target[key]);
  if (existing) {
    return existing;
  }
  const next: JsonSchemaNode = {};
  target[key] = next;
  return next;
}

function asRecord(value: unknown): JsonSchemaNode | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonSchemaNode)
    : null;
}

function isRecordLike(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
