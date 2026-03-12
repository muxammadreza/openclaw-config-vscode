import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "jsonc-parser";
import { promisify } from "node:util";
import type {
  DiscoveredChannelSurface,
  DiscoveredPlugin,
  DiscoveredPluginSurface,
  DiscoveredProviderSurface,
  PluginDiscoveryStatus,
} from "./types";

const execFile = promisify(execFileCallback);
const DEFAULT_DISCOVERY_TIMEOUT_MS = 8_000;
const MANIFEST_BASENAME = "openclaw.plugin.json";

type CliPluginListPayload = {
  plugins?: unknown[];
};

type ManifestRecord = {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  kind?: unknown;
  channels?: unknown;
  providers?: unknown;
  skills?: unknown;
  configSchema?: unknown;
  uiHints?: unknown;
};

export type PluginDiscoveryOptions = {
  commandPath: string;
  workspaceRoot?: string;
  configPath?: string;
  timeoutMs?: number;
};

export type PluginDiscoveryResult = {
  plugins: DiscoveredPlugin[];
  pluginSurfaces: DiscoveredPluginSurface[];
  channelSurfaces: DiscoveredChannelSurface[];
  providerSurfaces: DiscoveredProviderSurface[];
  status: PluginDiscoveryStatus;
};

export async function discoverInstalledPlugins(
  options: PluginDiscoveryOptions,
): Promise<PluginDiscoveryResult> {
  const commandPath = options.commandPath.trim() || "openclaw";
  let source: PluginDiscoveryStatus["source"] = "unavailable";
  let lastError: string | undefined;
  let warnings: string[] = [];
  let plugins: DiscoveredPlugin[] = [];

  try {
    plugins = await discoverViaCli({
      ...options,
      commandPath,
    });
    source = "cli";
  } catch (error) {
    lastError = toErrorMessage(error);
    const fallback = await discoverViaManifestFallback(options.configPath);
    plugins = fallback.plugins;
    warnings = fallback.warnings;
    if (plugins.length > 0) {
      source = "manifest-fallback";
    }
  }

  const pluginSurfaces = buildPluginSurfaces(plugins);
  const channelSurfaces = buildChannelSurfaces(plugins);
  const providerSurfaces = buildProviderSurfaces(plugins);

  return {
    plugins,
    pluginSurfaces,
    channelSurfaces,
    providerSurfaces,
    status: {
      source,
      commandPath,
      pluginCount: plugins.length,
      channelCount: channelSurfaces.length,
      providerCount: providerSurfaces.length,
      schemaBackedSurfaceCount: countSchemaBackedSurfaces([
        ...pluginSurfaces,
        ...channelSurfaces,
        ...providerSurfaces,
      ]),
      assistiveOnlySurfaceCount: countAssistiveOnlySurfaces([
        ...pluginSurfaces,
        ...channelSurfaces,
        ...providerSurfaces,
      ]),
      confidence: {
        explicit: pluginSurfaces.length + channelSurfaces.length + providerSurfaces.length,
        derived: 0,
        inferred: 0,
      },
      authoritative: source !== "unavailable",
      warnings,
      lastError,
    },
  };
}

async function discoverViaCli(options: PluginDiscoveryOptions): Promise<DiscoveredPlugin[]> {
  const { stdout } = await execFile(
    options.commandPath,
    ["plugins", "list", "--json"],
    {
      cwd: options.workspaceRoot,
      encoding: "utf8",
      timeout: options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    },
  );

  const plugins = parseCliPluginListRaw(stdout);
  const hydrated = await Promise.all(
    plugins.map(async (plugin) => hydrateInstalledPlugin(plugin)),
  );
  return hydrated.sort((left, right) => left.id.localeCompare(right.id));
}

async function discoverViaManifestFallback(
  configPath?: string,
): Promise<{ plugins: DiscoveredPlugin[]; warnings: string[] }> {
  const warnings: string[] = [];
  const manifests = new Map<string, DiscoveredPlugin>();

  for (const manifestPath of await collectManifestCandidatePaths(configPath)) {
    try {
      const plugin = await readManifestPlugin(manifestPath);
      if (plugin) {
        manifests.set(plugin.id, plugin);
      }
    } catch (error) {
      warnings.push(`Failed to read ${manifestPath}: ${toErrorMessage(error)}`);
    }
  }

  return {
    plugins: [...manifests.values()].sort((left, right) => left.id.localeCompare(right.id)),
    warnings,
  };
}

async function hydrateInstalledPlugin(plugin: DiscoveredPlugin): Promise<DiscoveredPlugin> {
  const pluginRoot = resolvePluginRootFromSource(plugin.source);
  const manifestPath = pluginRoot ? path.join(pluginRoot, MANIFEST_BASENAME) : undefined;
  const manifest = manifestPath ? await readManifestRecord(manifestPath) : null;

  return {
    ...plugin,
    pluginRoot,
    manifestPath,
    version: plugin.version ?? undefined,
    name: plugin.name ?? getOptionalString(manifest?.name) ?? undefined,
    description: plugin.description ?? getOptionalString(manifest?.description) ?? undefined,
    kind: plugin.kind ?? getOptionalString(manifest?.kind) ?? undefined,
    declaredChannels: mergeStringArrays(
      plugin.declaredChannels,
      asStringArray(manifest?.channels),
    ),
    declaredProviders: mergeStringArrays(
      plugin.declaredProviders,
      asStringArray(manifest?.providers),
    ),
    declaredSkills: mergeStringArrays(
      plugin.declaredSkills,
      asStringArray(manifest?.skills),
    ),
    configJsonSchema:
      plugin.configJsonSchema ??
      asRecord(manifest?.configSchema) ??
      undefined,
    configUiHints:
      plugin.configUiHints ??
      normalizeUiHints(manifest?.uiHints),
  };
}

function buildPluginSurfaces(plugins: readonly DiscoveredPlugin[]): DiscoveredPluginSurface[] {
  return plugins
    .map((plugin) => {
      const source: DiscoveredPluginSurface["source"] = plugin.configJsonSchema ? "cli" : "manifest";
      return {
      kind: "plugin" as const,
      id: plugin.id,
      path: `plugins.entries.${plugin.id}.config`,
      schema: plugin.configJsonSchema,
      uiHints: plugin.configUiHints,
      source,
      confidence: "explicit" as const,
      originPluginId: plugin.id,
      label: plugin.name ?? plugin.id,
      description: plugin.description,
    };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function buildChannelSurfaces(plugins: readonly DiscoveredPlugin[]): DiscoveredChannelSurface[] {
  const surfaces = new Map<string, DiscoveredChannelSurface>();

  for (const plugin of plugins) {
    for (const channelId of plugin.declaredChannels ?? []) {
      const normalized = channelId.trim();
      if (!normalized || surfaces.has(normalized)) {
        continue;
      }
      surfaces.set(normalized, {
        kind: "channel",
        id: normalized,
        path: `channels.${normalized}`,
        source: "manifest",
        confidence: "explicit",
        originPluginId: plugin.id,
        label: plugin.name ?? normalized,
        description: plugin.description,
      });
    }
  }

  return [...surfaces.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function buildProviderSurfaces(plugins: readonly DiscoveredPlugin[]): DiscoveredProviderSurface[] {
  const surfaces = new Map<string, DiscoveredProviderSurface>();

  for (const plugin of plugins) {
    for (const providerId of plugin.declaredProviders ?? []) {
      const normalized = providerId.trim();
      if (!normalized || surfaces.has(normalized)) {
        continue;
      }
      surfaces.set(normalized, {
        kind: "provider",
        id: normalized,
        path: `models.providers.${normalized}`,
        source: "manifest",
        confidence: "explicit",
        originPluginId: plugin.id,
        label: plugin.name ?? normalized,
        description: plugin.description,
      });
    }
  }

  return [...surfaces.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function parseCliPluginListRaw(raw: string): DiscoveredPlugin[] {
  const parsed = extractJsonPayload(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Local plugin discovery returned invalid JSON.");
  }

  const payload = parsed as CliPluginListPayload;
  if (!Array.isArray(payload.plugins)) {
    throw new Error("Local plugin discovery payload is missing plugins[].");
  }

  return payload.plugins
    .map((plugin) => normalizeCliPlugin(plugin))
    .filter((plugin): plugin is DiscoveredPlugin => plugin !== null)
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function extractJsonPayload(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const candidates = Array.from(trimmed.matchAll(/[{\[]/g), (match) => match.index ?? -1);
  for (const startIndex of candidates) {
    if (startIndex < 0) {
      continue;
    }
    const candidate = trimmed.slice(startIndex);
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      continue;
    }
  }

  return null;
}

async function collectManifestCandidatePaths(configPath?: string): Promise<string[]> {
  const pluginDirs = new Set<string>();
  const homeRoot = configPath
    ? path.dirname(configPath)
    : path.join(os.homedir(), ".openclaw");
  const effectiveConfigPath = configPath ?? path.join(homeRoot, "openclaw.json");
  const parsedConfig = await readJsoncFile<Record<string, unknown>>(effectiveConfigPath);
  const pluginsConfig = asRecord(parsedConfig?.plugins);

  const loadPaths = asRecord(pluginsConfig?.load);
  for (const configuredPath of asStringArray(loadPaths?.paths)) {
    pluginDirs.add(resolvePluginRoot(configuredPath));
  }

  const installs = asRecord(pluginsConfig?.installs);
  for (const installRecord of Object.values(installs ?? {})) {
    const typedRecord = asRecord(installRecord);
    const installPath = getOptionalString(typedRecord?.installPath);
    if (installPath) {
      pluginDirs.add(resolvePluginRoot(installPath));
    }
    const sourcePath = getOptionalString(typedRecord?.sourcePath);
    if (sourcePath) {
      pluginDirs.add(resolvePluginRoot(sourcePath));
    }
  }

  const globalExtensionsRoot = path.join(homeRoot, "extensions");
  for (const child of await readdirSafe(globalExtensionsRoot)) {
    pluginDirs.add(resolvePluginRoot(path.join(globalExtensionsRoot, child)));
  }

  return [...pluginDirs]
    .filter(Boolean)
    .map((pluginDir) => path.join(pluginDir, MANIFEST_BASENAME))
    .sort((left, right) => left.localeCompare(right));
}

async function readManifestPlugin(manifestPath: string): Promise<DiscoveredPlugin | null> {
  const manifest = await readManifestRecord(manifestPath);
  const id = getOptionalString(manifest?.id);
  if (!id) {
    return null;
  }

  return {
    id,
    version: getOptionalString((manifest as Record<string, unknown> | null)?.version) ?? undefined,
    name: getOptionalString(manifest?.name) ?? undefined,
    description: getOptionalString(manifest?.description) ?? undefined,
    kind: getOptionalString(manifest?.kind) ?? undefined,
    manifestPath,
    pluginRoot: path.dirname(manifestPath),
    declaredChannels: asStringArray(manifest?.channels),
    declaredProviders: asStringArray(manifest?.providers),
    declaredSkills: asStringArray(manifest?.skills),
    configJsonSchema: asRecord(manifest?.configSchema) ?? undefined,
    configUiHints: normalizeUiHints(manifest?.uiHints),
  };
}

async function readManifestRecord(manifestPath: string): Promise<ManifestRecord | null> {
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    return JSON.parse(raw) as ManifestRecord;
  } catch {
    return null;
  }
}

function normalizeCliPlugin(value: unknown): DiscoveredPlugin | null {
  const plugin = asRecord(value);
  if (!plugin) {
    return null;
  }
  const id = getOptionalString(plugin.id);
  if (!id) {
    return null;
  }

  return {
    id,
    version: getOptionalString(plugin.version) ?? undefined,
    name: getOptionalString(plugin.name) ?? undefined,
    description: getOptionalString(plugin.description) ?? undefined,
    kind: getOptionalString(plugin.kind) ?? undefined,
    enabled: typeof plugin.enabled === "boolean" ? plugin.enabled : undefined,
    status: getOptionalString(plugin.status) ?? undefined,
    source: getOptionalString(plugin.source) ?? undefined,
    origin: getOptionalString(plugin.origin) ?? undefined,
    declaredChannels: mergeStringArrays(
      asStringArray(plugin.channels),
      asStringArray(plugin.channelIds),
    ),
    declaredProviders: mergeStringArrays(
      asStringArray(plugin.providers),
      asStringArray(plugin.providerIds),
    ),
    declaredSkills: asStringArray(plugin.skills),
    configJsonSchema: asRecord(plugin.configJsonSchema) ?? undefined,
    configUiHints: normalizeUiHints(plugin.configUiHints),
  };
}

function normalizeUiHints(
  value: unknown,
): Record<string, Record<string, unknown>> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const normalized = Object.fromEntries(
    Object.entries(record)
      .filter(([key, hint]) => key.trim() && asRecord(hint))
      .map(([key, hint]) => [key.trim(), asRecord(hint)!]),
  );

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function resolvePluginRootFromSource(sourcePath: string | undefined): string | undefined {
  if (!sourcePath) {
    return undefined;
  }
  return resolvePluginRoot(sourcePath);
}

function resolvePluginRoot(sourcePath: string): string {
  const resolved = path.resolve(sourcePath.replace(/^~(?=$|\/|\\)/, os.homedir()));
  return path.extname(resolved) ? path.dirname(resolved) : resolved;
}

async function readJsoncFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return parse(raw) as T;
  } catch {
    return null;
  }
}

async function readdirSafe(dirPath: string): Promise<string[]> {
  try {
    return await fs.readdir(dirPath);
  } catch {
    return [];
  }
}

function mergeStringArrays(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): string[] | undefined {
  const merged = new Set<string>();
  for (const candidate of [...(left ?? []), ...(right ?? [])]) {
    const normalized = candidate.trim();
    if (normalized) {
      merged.add(normalized);
    }
  }
  return merged.size > 0 ? [...merged].sort((a, b) => a.localeCompare(b)) : undefined;
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

function countSchemaBackedSurfaces(
  surfaces: ReadonlyArray<{ schema?: Record<string, unknown> }>,
): number {
  return surfaces.filter((surface) => Boolean(surface.schema)).length;
}

function countAssistiveOnlySurfaces(
  surfaces: ReadonlyArray<{ schema?: Record<string, unknown> }>,
): number {
  return surfaces.filter((surface) => !surface.schema).length;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
