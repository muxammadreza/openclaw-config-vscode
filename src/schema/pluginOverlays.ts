import type { DiscoveredPlugin } from "./types";

type JsonSchemaNode = Record<string, unknown>;
type UiHintRecord = Record<string, Record<string, unknown>>;

export type PluginSchemaOverlay = {
  schemaText: string;
  uiHintsText: string;
};

export function applyPluginOverlays(
  schemaText: string,
  uiHintsText: string,
  plugins: readonly DiscoveredPlugin[],
): PluginSchemaOverlay {
  const schema = parseRecord(schemaText);
  const uiHints = parseUiHints(uiHintsText);

  const schemaWithPlugins = applyPluginIdConstraints(applyPluginSchemas(schema, plugins), plugins);
  const hintsWithPlugins = applyPluginHints(uiHints, plugins);

  return {
    schemaText: JSON.stringify(schemaWithPlugins, null, 2),
    uiHintsText: JSON.stringify(hintsWithPlugins, null, 2),
  };
}

function applyPluginSchemas(
  schema: JsonSchemaNode,
  plugins: readonly DiscoveredPlugin[],
): JsonSchemaNode {
  const next = cloneJson(schema);
  const rootProperties = asRecord(next["properties"]);
  const pluginsNode = asRecord(rootProperties?.["plugins"]);
  const pluginsProperties = asRecord(pluginsNode?.["properties"]);
  const entriesNode = asRecord(pluginsProperties?.["entries"]);
  if (!entriesNode) {
    return next;
  }

  const baseEntry = asRecord(entriesNode.additionalProperties) ?? { type: "object" };
  const entryProperties = ensureRecord(entriesNode, "properties");

  for (const plugin of plugins) {
    const entrySchema = cloneJson(baseEntry);
    const entrySchemaProperties = ensureRecord(entrySchema, "properties");
    if (plugin.configJsonSchema) {
      const baseConfigSchema = asRecord(entrySchemaProperties.config);
      entrySchemaProperties.config = mergeObjectSchema(baseConfigSchema, plugin.configJsonSchema);
    }
    entryProperties[plugin.id] = entrySchema;
  }

  return next;
}

function applyPluginHints(
  uiHints: UiHintRecord,
  plugins: readonly DiscoveredPlugin[],
): UiHintRecord {
  const next = cloneJson(uiHints);

  for (const plugin of plugins) {
    const pluginId = plugin.id.trim();
    if (!pluginId) {
      continue;
    }
    const name = plugin.name?.trim() || pluginId;
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

    for (const [relativePath, hint] of Object.entries(plugin.configUiHints ?? {})) {
      const normalizedPath = relativePath.trim().replace(/^\./, "");
      if (!normalizedPath) {
        continue;
      }
      next[`${basePath}.config.${normalizedPath}`] = {
        ...next[`${basePath}.config.${normalizedPath}`],
        ...hint,
      };
    }
  }

  return next;
}

function applyPluginIdConstraints(
  schema: JsonSchemaNode,
  plugins: readonly DiscoveredPlugin[],
): JsonSchemaNode {
  const next = cloneJson(schema);
  const rootProperties = asRecord(next["properties"]);
  const pluginsSchema = asRecord(rootProperties?.["plugins"]);
  const pluginProperties = asRecord(pluginsSchema?.["properties"]);
  if (!pluginProperties) {
    return next;
  }

  const pluginIds = plugins.map((plugin) => plugin.id).filter(Boolean).sort((left, right) => left.localeCompare(right));
  if (pluginIds.length === 0) {
    return next;
  }

  const allowSchema = asRecord(pluginProperties.allow);
  const denySchema = asRecord(pluginProperties.deny);
  const slotsSchema = asRecord(pluginProperties.slots);
  const slotProperties = asRecord(slotsSchema?.properties);

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
    const memorySchema = asRecord(slotProperties.memory);
    if (memorySchema && memoryIds.length > 0) {
      memorySchema.enum = ["none", ...memoryIds];
    }

    const contextSchema = asRecord(slotProperties.contextEngine);
    if (contextSchema && contextEngineIds.length > 0) {
      contextSchema.enum = ["legacy", ...contextEngineIds];
    }
  }

  return next;
}

function mergeObjectSchema(
  baseSchema: JsonSchemaNode | null,
  pluginSchema: JsonSchemaNode,
): JsonSchemaNode {
  const next = cloneJson(pluginSchema);
  if (!baseSchema) {
    return next;
  }
  if (baseSchema.type !== "object" || pluginSchema.type !== "object") {
    return next;
  }

  const nextProperties = ensureRecord(next, "properties");
  const baseProperties = asRecord(baseSchema.properties) ?? {};
  for (const [key, value] of Object.entries(baseProperties)) {
    if (!(key in nextProperties)) {
      nextProperties[key] = cloneJson(value);
    }
  }

  if (!("additionalProperties" in next) && "additionalProperties" in baseSchema) {
    next.additionalProperties = cloneJson(baseSchema.additionalProperties);
  }
  if (!("propertyNames" in next) && "propertyNames" in baseSchema) {
    next.propertyNames = cloneJson(baseSchema.propertyNames);
  }

  const baseRequired = Array.isArray(baseSchema.required) ? baseSchema.required : [];
  const nextRequired = Array.isArray(next.required) ? next.required : [];
  const mergedRequired = [...new Set([...baseRequired, ...nextRequired])];
  if (mergedRequired.length > 0) {
    next.required = mergedRequired;
  }

  return next;
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
    return asRecord(parsed) as UiHintRecord ?? {};
  } catch {
    return {};
  }
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
