import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "jsonc-parser";
import ts from "typescript";
import { promisify } from "node:util";
import type {
  DiscoveryConfidence,
  DiscoveredChannelSurface,
  DiscoveredPlugin,
  DiscoveredPluginSurface,
  DiscoveredProviderSurface,
  PluginCodeTraversalMode,
  PluginDiscoveryStatus,
} from "./types";

const execFile = promisify(execFileCallback);
const DEFAULT_DISCOVERY_TIMEOUT_MS = 8_000;
const MAX_AST_FILES = 120;
const CONFIG_PATH_LITERAL_PATTERN =
  /^(?:channels\.[a-z0-9_-]+|models\.providers\.[a-z0-9_-]+)(?:\.[a-z0-9_*_-]+)+$/i;
const CONFIG_PATH_PROPERTY_NAMES = new Set([
  "configPrefixes",
  "policyPath",
  "allowFromPath",
  "groupPolicyPath",
  "groupAllowFromPath",
  "routeAllowlistPath",
]);

type CliPluginListPayload = {
  plugins?: unknown[];
};

type ManifestRecord = {
  id?: string;
  name?: string;
  description?: string;
  kind?: string;
  configSchema?: unknown;
  uiHints?: unknown;
  channels?: unknown;
  providers?: unknown;
};

type InstalledPluginCandidate = DiscoveredPlugin & {
  pluginRoot?: string;
  manifestPath?: string;
  declaredChannels: string[];
  declaredProviders: string[];
};

type SurfaceBundle = {
  pluginSurfaces: DiscoveredPluginSurface[];
  channelSurfaces: DiscoveredChannelSurface[];
  providerSurfaces: DiscoveredProviderSurface[];
  lastTraversalError?: string;
};

type ChannelSurfaceSeed = {
  channelId: string;
  originPluginId: string;
  label?: string;
  description?: string;
};

type AstExtractionRecord = {
  channelPaths: Map<string, Set<string>>;
  providerPaths: Map<string, Set<string>>;
  providerSurfaceSeeds: DiscoveredProviderSurface[];
  labels: Map<string, string>;
  descriptions: Map<string, string>;
};

type StringLiteralMap = Map<string, string>;
type VariableExpressionMap = Map<string, ts.Expression>;
type InferenceContext = {
  literals: StringLiteralMap;
  variables: VariableExpressionMap;
  visiting?: Set<string>;
};

export type PluginDiscoveryOptions = {
  commandPath: string;
  codeTraversalMode: PluginCodeTraversalMode;
  workspaceRoot?: string;
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
  let plugins: InstalledPluginCandidate[] = [];

  try {
    plugins = await discoverViaCli({
      ...options,
      commandPath,
    });
    source = "cli";
  } catch (error) {
    lastError = toErrorMessage(error);
    plugins = await discoverViaManifestFallback();
    if (plugins.length > 0) {
      source = "manifest-fallback";
    }
  }

  const surfaces = plugins.length > 0
    ? await discoverInstalledSurfaces(plugins, options.codeTraversalMode)
    : {
        pluginSurfaces: [],
        channelSurfaces: [],
        providerSurfaces: [],
      };

  return {
    plugins: plugins.map(stripCandidate),
    pluginSurfaces: surfaces.pluginSurfaces,
    channelSurfaces: surfaces.channelSurfaces,
    providerSurfaces: surfaces.providerSurfaces,
    status: {
      source,
      commandPath,
      pluginCount: plugins.length,
      channelCount: surfaces.channelSurfaces.length,
      providerCount: surfaces.providerSurfaces.length,
      schemaBackedSurfaceCount: countSchemaBackedSurfaces([
        ...surfaces.pluginSurfaces,
        ...surfaces.channelSurfaces,
        ...surfaces.providerSurfaces,
      ]),
      assistiveOnlySurfaceCount: countAssistiveOnlySurfaces([
        ...surfaces.pluginSurfaces,
        ...surfaces.channelSurfaces,
        ...surfaces.providerSurfaces,
      ]),
      codeTraversalMode: options.codeTraversalMode,
      confidence: countConfidenceLevels([
        ...surfaces.pluginSurfaces,
        ...surfaces.channelSurfaces,
        ...surfaces.providerSurfaces,
      ]),
      lastError,
      lastTraversalError: surfaces.lastTraversalError,
    },
  };
}

async function discoverViaCli(options: PluginDiscoveryOptions): Promise<InstalledPluginCandidate[]> {
  const { stdout } = await execFile(
    options.commandPath,
    ["plugins", "list", "--json"],
    {
      cwd: options.workspaceRoot,
      encoding: "utf8",
      timeout: options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    },
  );

  return hydrateInstalledPlugins(parseCliPluginListRaw(stdout));
}

async function discoverViaManifestFallback(): Promise<InstalledPluginCandidate[]> {
  const manifests = new Map<string, InstalledPluginCandidate>();

  for (const candidatePath of await collectManifestCandidatePaths()) {
    const plugin = await readManifestPlugin(candidatePath).catch(() => null);
    if (!plugin) {
      continue;
    }
    manifests.set(plugin.id, plugin);
  }

  return [...manifests.values()].sort((left, right) => left.id.localeCompare(right.id));
}

async function hydrateInstalledPlugins(
  rawPlugins: DiscoveredPlugin[],
): Promise<InstalledPluginCandidate[]> {
  const next = await Promise.all(rawPlugins.map((plugin) => hydrateInstalledPlugin(plugin)));
  return next.sort((left, right) => left.id.localeCompare(right.id));
}

async function hydrateInstalledPlugin(plugin: DiscoveredPlugin): Promise<InstalledPluginCandidate> {
  const pluginRoot = resolvePluginRootFromSource(plugin.source);
  const manifestPath = pluginRoot ? path.join(pluginRoot, "openclaw.plugin.json") : undefined;
  const manifest = manifestPath ? await readManifestRecord(manifestPath) : null;

  return {
    ...plugin,
    pluginRoot,
    manifestPath,
    name: plugin.name ?? getOptionalString(manifest?.name) ?? undefined,
    description: plugin.description ?? getOptionalString(manifest?.description) ?? undefined,
    kind: plugin.kind ?? getOptionalString(manifest?.kind) ?? undefined,
    configJsonSchema:
      plugin.configJsonSchema ??
      asRecord(manifest?.configSchema) ??
      undefined,
    configUiHints:
      plugin.configUiHints ??
      normalizeUiHints(manifest?.uiHints),
    declaredChannels: asStringArray(manifest?.channels),
    declaredProviders: asStringArray(manifest?.providers),
  };
}

async function discoverInstalledSurfaces(
  plugins: readonly InstalledPluginCandidate[],
  codeTraversalMode: PluginCodeTraversalMode,
): Promise<SurfaceBundle> {
  const pluginSurfaces = mergeSurfaceList(
    plugins.map((plugin) => buildPluginSurface(plugin)),
  ) as DiscoveredPluginSurface[];

  const surfaceMap = new Map<string, DiscoveredChannelSurface | DiscoveredProviderSurface>();
  let lastTraversalError: string | undefined;

  for (const plugin of plugins) {
    for (const channelId of plugin.declaredChannels) {
      mergeSurface(surfaceMap, buildDeclaredChannelSurface(plugin, channelId));
    }
    for (const providerId of plugin.declaredProviders) {
      mergeSurface(surfaceMap, buildDeclaredProviderSurface(plugin, providerId));
    }
  }

  if (codeTraversalMode !== "off") {
    try {
      const bundledSurfaces = await discoverBundledChannelSurfaces(plugins);
      for (const surface of bundledSurfaces) {
        mergeSurface(surfaceMap, surface);
      }
    } catch (error) {
      lastTraversalError = toErrorMessage(error);
    }

    try {
      const astSurfaces = await discoverAstDerivedSurfaces(plugins, codeTraversalMode);
      for (const surface of [...astSurfaces.channelSurfaces, ...astSurfaces.providerSurfaces]) {
        mergeSurface(surfaceMap, surface);
      }
      if (astSurfaces.lastTraversalError) {
        lastTraversalError = astSurfaces.lastTraversalError;
      }
    } catch (error) {
      lastTraversalError = toErrorMessage(error);
    }
  }

  const channelSurfaces = [...surfaceMap.values()]
    .filter((surface): surface is DiscoveredChannelSurface => surface.kind === "channel")
    .sort((left, right) => left.id.localeCompare(right.id));
  const providerSurfaces = [...surfaceMap.values()]
    .filter((surface): surface is DiscoveredProviderSurface => surface.kind === "provider")
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    pluginSurfaces,
    channelSurfaces,
    providerSurfaces,
    lastTraversalError,
  };
}

function buildPluginSurface(plugin: InstalledPluginCandidate): DiscoveredPluginSurface {
  const hasExplicitMetadata = Boolean(plugin.configJsonSchema || plugin.configUiHints);
  return {
    kind: "plugin",
    id: plugin.id,
    path: `plugins.entries.${plugin.id}.config`,
    schema: plugin.configJsonSchema ?? {
      type: "object",
      additionalProperties: true,
    },
    uiHints: plugin.configUiHints,
    source: hasExplicitMetadata ? "cli" : "manifest",
    confidence: hasExplicitMetadata ? "explicit" : "inferred",
    originPluginId: plugin.id,
    label: plugin.name ?? plugin.id,
    description: plugin.description,
  };
}

function buildDeclaredChannelSurface(
  plugin: InstalledPluginCandidate,
  channelId: string,
): DiscoveredChannelSurface {
  return {
    kind: "channel",
    id: channelId,
    path: `channels.${channelId}`,
    source: "manifest",
    confidence: "inferred",
    originPluginId: plugin.id,
    label: plugin.name ?? channelId,
    description: plugin.description,
    assistivePaths: [`channels.${channelId}`],
  };
}

function buildDeclaredProviderSurface(
  plugin: InstalledPluginCandidate,
  providerId: string,
): DiscoveredProviderSurface {
  return {
    kind: "provider",
    id: providerId,
    path: `models.providers.${providerId}`,
    source: "manifest",
    confidence: "inferred",
    originPluginId: plugin.id,
    label: plugin.name ?? providerId,
    description: plugin.description,
    assistivePaths: [`models.providers.${providerId}`],
  };
}

async function discoverBundledChannelSurfaces(
  plugins: readonly InstalledPluginCandidate[],
): Promise<DiscoveredChannelSurface[]> {
  const surfaces: DiscoveredChannelSurface[] = [];

  for (const plugin of plugins) {
    if (plugin.origin !== "bundled" || plugin.declaredChannels.length === 0) {
      continue;
    }
    const modulePath = resolveBundledPluginSdkModulePath(plugin);
    if (!modulePath) {
      continue;
    }

    try {
      const moduleExports = await import(pathToFileURL(modulePath).href);
      for (const channelId of plugin.declaredChannels) {
        let surface = buildBundledChannelSurfaceFromModule({
          channelId,
          originPluginId: plugin.id,
          label: plugin.name ?? channelId,
          description: plugin.description,
        }, moduleExports);
        if (!surface) {
          surface = await buildBundledChannelSurfaceFromSource(plugin, channelId);
        }
        if (surface) {
          surfaces.push(surface);
        }
      }
    } catch {
      for (const channelId of plugin.declaredChannels) {
        const surface = await buildBundledChannelSurfaceFromSource(plugin, channelId);
        if (surface) {
          surfaces.push(surface);
        }
      }
    }
  }

  return surfaces;
}

export function buildBundledChannelSurfaceFromModule(
  seed: ChannelSurfaceSeed,
  moduleExports: Record<string, unknown>,
): DiscoveredChannelSurface | null {
  const buildChannelConfigSchema =
    typeof moduleExports.buildChannelConfigSchema === "function"
      ? moduleExports.buildChannelConfigSchema as (value: unknown) => unknown
      : null;
  if (!buildChannelConfigSchema) {
    return null;
  }

  const schemaExport = findConfigSchemaExport(seed.channelId, moduleExports);
  if (!schemaExport) {
    return null;
  }

  const built = asRecord(buildChannelConfigSchema(schemaExport));
  const schema = asRecord(built?.schema ?? built);
  if (!schema) {
    return null;
  }

  return {
    kind: "channel",
    id: seed.channelId,
    path: `channels.${seed.channelId}`,
    schema,
    uiHints: normalizeUiHints(built?.uiHints),
    source: "bundled-sdk",
    confidence: "derived",
    originPluginId: seed.originPluginId,
    label: seed.label,
    description: seed.description,
  };
}

async function buildBundledChannelSurfaceFromSource(
  plugin: InstalledPluginCandidate,
  channelId: string,
): Promise<DiscoveredChannelSurface | null> {
  if (!plugin.pluginRoot) {
    return null;
  }

  const files = await collectTraversalFiles(plugin.pluginRoot, "installed-sources");
  for (const absolutePath of files) {
    const raw = await fs.readFile(absolutePath, "utf8").catch(() => null);
    if (!raw) {
      continue;
    }
    const surface = buildBundledChannelSurfaceFromSourceText(
      raw,
      absolutePath,
      {
        channelId,
        originPluginId: plugin.id,
        label: plugin.name ?? channelId,
        description: plugin.description,
      },
    );
    if (surface) {
      return surface;
    }
  }

  return null;
}

export function buildBundledChannelSurfaceFromSourceText(
  raw: string,
  fileName: string,
  seed: ChannelSurfaceSeed,
): DiscoveredChannelSurface | null {
  const sourceFile = ts.createSourceFile(
    fileName,
    raw,
    ts.ScriptTarget.Latest,
    true,
    inferScriptKind(fileName),
  );
  const literals = collectStringConstants(sourceFile);
  const variables = collectVariableInitializers(sourceFile);
  const context: InferenceContext = {
    literals,
    variables,
  };

  for (const candidateName of buildChannelSchemaCandidateNames(seed.channelId)) {
    const candidate = variables.get(candidateName);
    if (!candidate) {
      continue;
    }
    const schema = inferSchemaFromExpression(candidate, context);
    if (isObjectSchema(schema)) {
      return {
        kind: "channel",
        id: seed.channelId,
        path: `channels.${seed.channelId}`,
        schema,
        source: "code-ast",
        confidence: "derived",
        originPluginId: seed.originPluginId,
        label: seed.label,
        description: seed.description,
        assistivePaths: collectAssistivePathsFromSchema(`channels.${seed.channelId}`, schema),
      };
    }
  }

  let matchedSurface: DiscoveredChannelSurface | null = null;
  walkAst(sourceFile, (node) => {
    if (matchedSurface || !ts.isObjectLiteralExpression(node)) {
      return;
    }
    const idValue = readStringLiteral(getObjectPropertyInitializer(node, "id"), literals);
    if (idValue !== seed.channelId) {
      return;
    }
    const configSchemaNode = getObjectPropertyInitializer(node, "configSchema");
    const schema = configSchemaNode ? inferSchemaFromExpression(configSchemaNode, context) : undefined;
    if (!isObjectSchema(schema)) {
      return;
    }
    matchedSurface = {
      kind: "channel",
      id: seed.channelId,
      path: `channels.${seed.channelId}`,
      schema,
      source: "code-ast",
      confidence: "derived",
      originPluginId: seed.originPluginId,
      label: seed.label,
      description: seed.description,
      assistivePaths: collectAssistivePathsFromSchema(`channels.${seed.channelId}`, schema),
    };
  });

  return matchedSurface;
}

async function discoverAstDerivedSurfaces(
  plugins: readonly InstalledPluginCandidate[],
  codeTraversalMode: PluginCodeTraversalMode,
): Promise<Pick<SurfaceBundle, "channelSurfaces" | "providerSurfaces" | "lastTraversalError">> {
  const channelMap = new Map<string, DiscoveredChannelSurface>();
  const providerMap = new Map<string, DiscoveredProviderSurface>();
  let lastTraversalError: string | undefined;

  for (const plugin of plugins) {
    if (!plugin.pluginRoot) {
      continue;
    }

    try {
      const record = await extractAstSurfaceRecord(plugin, codeTraversalMode);
      for (const [channelId, paths] of record.channelPaths) {
        mergeSurface(
          channelMap,
          {
            kind: "channel",
            id: channelId,
            path: `channels.${channelId}`,
            source: "code-ast",
            confidence: "inferred",
            originPluginId: plugin.id,
            label: record.labels.get(`channels.${channelId}`) ?? plugin.name ?? channelId,
            description: record.descriptions.get(`channels.${channelId}`) ?? plugin.description,
            assistivePaths: [...paths].sort((left, right) => left.localeCompare(right)),
          },
        );
      }

      for (const [providerId, paths] of record.providerPaths) {
        mergeSurface(
          providerMap,
          {
            kind: "provider",
            id: providerId,
            path: `models.providers.${providerId}`,
            source: "code-ast",
            confidence: "inferred",
            originPluginId: plugin.id,
            label: record.labels.get(`models.providers.${providerId}`) ?? plugin.name ?? providerId,
            description: record.descriptions.get(`models.providers.${providerId}`) ?? plugin.description,
            assistivePaths: [...paths].sort((left, right) => left.localeCompare(right)),
          },
        );
      }

      for (const surface of record.providerSurfaceSeeds) {
        mergeSurface(providerMap, surface);
      }
    } catch (error) {
      lastTraversalError = toErrorMessage(error);
    }
  }

  return {
    channelSurfaces: [...channelMap.values()].sort((left, right) => left.id.localeCompare(right.id)),
    providerSurfaces: [...providerMap.values()].sort((left, right) => left.id.localeCompare(right.id)),
    lastTraversalError,
  };
}

async function extractAstSurfaceRecord(
  plugin: InstalledPluginCandidate,
  codeTraversalMode: PluginCodeTraversalMode,
): Promise<AstExtractionRecord> {
  const files = await collectTraversalFiles(plugin.pluginRoot!, codeTraversalMode);
  const record: AstExtractionRecord = {
    channelPaths: new Map(),
    providerPaths: new Map(),
    providerSurfaceSeeds: [],
    labels: new Map(),
    descriptions: new Map(),
  };

  for (const absolutePath of files) {
    const raw = await fs.readFile(absolutePath, "utf8").catch(() => null);
    if (!raw) {
      continue;
    }
    const extracted = extractAstSurfaceDataFromText(raw, absolutePath, plugin);
    mergePathMaps(record.channelPaths, extracted.channelPaths);
    mergePathMaps(record.providerPaths, extracted.providerPaths);
    for (const surface of extracted.providerSurfaceSeeds) {
      record.providerSurfaceSeeds.push(surface);
    }
    for (const [key, value] of extracted.labels) {
      if (!record.labels.has(key)) {
        record.labels.set(key, value);
      }
    }
    for (const [key, value] of extracted.descriptions) {
      if (!record.descriptions.has(key)) {
        record.descriptions.set(key, value);
      }
    }
  }

  return record;
}

export function extractAstSurfaceDataFromText(
  raw: string,
  fileName: string,
  plugin: Pick<InstalledPluginCandidate, "id" | "name" | "description" | "declaredProviders">,
): AstExtractionRecord {
  const sourceFile = ts.createSourceFile(
    fileName,
    raw,
    ts.ScriptTarget.Latest,
    true,
    inferScriptKind(fileName),
  );
  const literals = collectStringConstants(sourceFile);
  const variables = collectVariableInitializers(sourceFile);
  const inferenceContext: InferenceContext = {
    literals,
    variables,
  };
  const channelPaths = new Map<string, Set<string>>();
  const providerPaths = new Map<string, Set<string>>();
  const providerSurfaceSeeds: DiscoveredProviderSurface[] = [];
  const labels = new Map<string, string>();
  const descriptions = new Map<string, string>();

  collectConfiguredPathLiterals(sourceFile, literals, channelPaths, providerPaths);

  walkAst(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) {
      return;
    }
    if (!isPropertyAccessName(node.expression, "registerProvider")) {
      return;
    }
    const [firstArg] = node.arguments;
    if (!firstArg || !ts.isObjectLiteralExpression(firstArg)) {
      return;
    }

    const providerId =
      readStringLiteral(getObjectPropertyInitializer(firstArg, "id"), literals) ??
      plugin.declaredProviders[0];
    if (!providerId) {
      return;
    }

    const label = readStringLiteral(getObjectPropertyInitializer(firstArg, "label"), literals);
    if (label) {
      labels.set(`models.providers.${providerId}`, label);
    }
    if (plugin.description) {
      descriptions.set(`models.providers.${providerId}`, plugin.description);
    }

    for (const configPatch of collectConfigPatchObjects(firstArg, literals)) {
      const providersNode = getNestedObjectProperty(configPatch, ["models", "providers"], literals);
      if (!providersNode || !ts.isObjectLiteralExpression(providersNode)) {
        continue;
      }
      for (const property of providersNode.properties) {
        if (!ts.isPropertyAssignment(property)) {
          continue;
        }
        const discoveredProviderId = readPropertyName(property.name, literals);
        if (!discoveredProviderId) {
          continue;
        }
        const inferredSchema = inferSchemaFromExpression(property.initializer, inferenceContext);
        if (!inferredSchema) {
          continue;
        }

        const providerPath = `models.providers.${discoveredProviderId}`;
        collectAssistivePathsFromExpression(
          property.initializer,
          providerPath,
          literals,
          providerPaths,
          discoveredProviderId,
        );
        providerSurfaceSeeds.push({
          kind: "provider",
          id: discoveredProviderId,
          path: providerPath,
          schema: inferredSchema,
          source: "code-ast",
          confidence: "derived",
          originPluginId: plugin.id,
          label:
            discoveredProviderId === providerId
              ? (label ?? plugin.name ?? discoveredProviderId)
              : discoveredProviderId,
          description: plugin.description,
          assistivePaths: [...(providerPaths.get(discoveredProviderId) ?? new Set([providerPath]))]
            .sort((left, right) => left.localeCompare(right)),
        });
      }
    }
  });

  return {
    channelPaths,
    providerPaths,
    providerSurfaceSeeds,
    labels,
    descriptions,
  };
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

  const candidates = [...trimmed.matchAll(/[{\[]/g)].map((match) => match.index ?? -1);
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

async function collectManifestCandidatePaths(): Promise<string[]> {
  const pluginDirs = new Set<string>();
  const homeRoot = path.join(os.homedir(), ".openclaw");
  const configPath = path.join(homeRoot, "openclaw.json");
  const parsedConfig = await readJsoncFile<Record<string, unknown>>(configPath);
  const pluginsConfig = asRecord(parsedConfig?.plugins);

  const loadPaths = asRecord(pluginsConfig?.load);
  const configuredPaths = asStringArray(loadPaths?.paths);
  for (const configuredPath of configuredPaths) {
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
    .map((pluginDir) => path.join(pluginDir, "openclaw.plugin.json"))
    .sort((left, right) => left.localeCompare(right));
}

async function readManifestPlugin(manifestPath: string): Promise<InstalledPluginCandidate | null> {
  const manifest = await readManifestRecord(manifestPath);
  const id = getOptionalString(manifest?.id);
  if (!id) {
    return null;
  }

  return {
    id,
    name: getOptionalString(manifest?.name) ?? undefined,
    description: getOptionalString(manifest?.description) ?? undefined,
    kind: getOptionalString(manifest?.kind) ?? undefined,
    configJsonSchema: asRecord(manifest?.configSchema) ?? undefined,
    configUiHints: normalizeUiHints(manifest?.uiHints),
    manifestPath,
    pluginRoot: path.dirname(manifestPath),
    declaredChannels: asStringArray(manifest?.channels),
    declaredProviders: asStringArray(manifest?.providers),
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
    name: getOptionalString(plugin.name) ?? undefined,
    description: getOptionalString(plugin.description) ?? undefined,
    kind: getOptionalString(plugin.kind) ?? undefined,
    enabled: typeof plugin.enabled === "boolean" ? plugin.enabled : undefined,
    status: getOptionalString(plugin.status) ?? undefined,
    source: getOptionalString(plugin.source) ?? undefined,
    origin: getOptionalString(plugin.origin) ?? undefined,
    configJsonSchema: asRecord(plugin.configJsonSchema) ?? undefined,
    configUiHints: normalizeUiHints(plugin.configUiHints),
  };
}

function findConfigSchemaExport(
  channelId: string,
  moduleExports: Record<string, unknown>,
): unknown {
  const candidates = [
    `${toPascalCase(channelId)}ConfigSchema`,
    `${toPascalCase(channelId)}ChannelConfigSchema`,
  ];
  for (const candidate of candidates) {
    if (candidate in moduleExports) {
      return moduleExports[candidate];
    }
  }
  return null;
}

function resolveBundledPluginSdkModulePath(plugin: InstalledPluginCandidate): string | null {
  if (!plugin.pluginRoot) {
    return null;
  }
  const parentDir = path.dirname(plugin.pluginRoot);
  if (path.basename(parentDir) !== "extensions") {
    return null;
  }
  return path.join(path.dirname(parentDir), "dist", "plugin-sdk", `${plugin.id}.js`);
}

function resolvePluginRootFromSource(sourcePath: string | undefined): string | undefined {
  if (!sourcePath) {
    return undefined;
  }
  return resolvePluginRoot(sourcePath);
}

async function collectTraversalFiles(
  pluginRoot: string,
  codeTraversalMode: PluginCodeTraversalMode,
): Promise<string[]> {
  const preferredRoots = [
    path.join(pluginRoot, "src"),
    pluginRoot,
  ];
  if (codeTraversalMode === "max-coverage") {
    preferredRoots.push(path.join(pluginRoot, "dist"));
  }

  const files: string[] = [];
  for (const root of preferredRoots) {
    const stat = await fs.stat(root).catch(() => null);
    if (!stat) {
      continue;
    }
    if (stat.isFile()) {
      files.push(root);
      continue;
    }
    await collectSourceFilesRecursively(root, files);
    if (files.length >= MAX_AST_FILES) {
      break;
    }
  }

  return [...new Set(files)].slice(0, MAX_AST_FILES);
}

async function collectSourceFilesRecursively(absolutePath: string, output: string[]): Promise<void> {
  if (output.length >= MAX_AST_FILES) {
    return;
  }

  const entries = await fs.readdir(absolutePath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (output.length >= MAX_AST_FILES) {
      return;
    }
    if (entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }
    const childPath = path.join(absolutePath, entry.name);
    if (entry.isDirectory()) {
      await collectSourceFilesRecursively(childPath, output);
      continue;
    }
    if (/\.(?:[cm]?js|[cm]?ts|tsx)$/.test(entry.name)) {
      output.push(childPath);
    }
  }
}

function collectStringConstants(sourceFile: ts.SourceFile): StringLiteralMap {
  const next = new Map<string, string>();

  walkAst(sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) {
      return;
    }
    const literal = readStringLiteral(node.initializer, next);
    if (literal) {
      next.set(node.name.text, literal);
    }
  });

  return next;
}

function collectVariableInitializers(sourceFile: ts.SourceFile): VariableExpressionMap {
  const next = new Map<string, ts.Expression>();

  walkAst(sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) {
      return;
    }
    next.set(node.name.text, node.initializer);
  });

  return next;
}

function readStringLiteral(
  node: ts.Expression | undefined,
  literals: StringLiteralMap,
): string | undefined {
  if (!node) {
    return undefined;
  }
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text.trim() || undefined;
  }
  if (ts.isIdentifier(node)) {
    return literals.get(node.text);
  }
  return undefined;
}

function collectConfiguredPathLiterals(
  sourceFile: ts.SourceFile,
  literals: StringLiteralMap,
  channelPaths: Map<string, Set<string>>,
  providerPaths: Map<string, Set<string>>,
): void {
  walkAst(sourceFile, (node) => {
    if (!ts.isPropertyAssignment(node)) {
      return;
    }
    const propertyName = readPropertyName(node.name, literals);
    if (!propertyName || !CONFIG_PATH_PROPERTY_NAMES.has(propertyName)) {
      return;
    }

    for (const literalPath of collectPathLiteralsFromExpression(node.initializer, literals)) {
      addDiscoveredPath(channelPaths, providerPaths, literalPath);
    }
  });
}

function collectPathLiteralsFromExpression(
  node: ts.Expression,
  literals: StringLiteralMap,
): string[] {
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.flatMap((element) =>
      ts.isExpression(element) ? collectPathLiteralsFromExpression(element, literals) : [],
    );
  }

  const literal = readStringLiteral(node, literals) ?? readTemplateLiteral(node, literals);
  if (!literal) {
    return [];
  }

  const normalized = normalizePath(literal);
  return CONFIG_PATH_LITERAL_PATTERN.test(normalized) ? [normalized] : [];
}

function readTemplateLiteral(
  node: ts.Expression | undefined,
  literals: StringLiteralMap,
): string | undefined {
  if (!node || !ts.isTemplateExpression(node)) {
    return undefined;
  }

  let next = node.head.text;
  for (const span of node.templateSpans) {
    const value = readStringLiteral(span.expression, literals);
    if (!value) {
      return undefined;
    }
    next += value + span.literal.text;
  }
  return next.trim() || undefined;
}

function addDiscoveredPath(
  channelPaths: Map<string, Set<string>>,
  providerPaths: Map<string, Set<string>>,
  matchedPath: string,
): void {
  if (matchedPath.startsWith("channels.")) {
    const [, channelId] = matchedPath.split(".", 3);
    if (channelId) {
      addSurfacePath(channelPaths, channelId, matchedPath);
    }
    return;
  }

  if (matchedPath.startsWith("models.providers.")) {
    const [, , providerId] = matchedPath.split(".", 4);
    if (providerId) {
      addSurfacePath(providerPaths, providerId, matchedPath);
    }
  }
}

function getObjectPropertyInitializer(
  node: ts.ObjectLiteralExpression,
  propertyName: string,
): ts.Expression | undefined {
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
      continue;
    }
    const name = readPropertyName(property.name);
    if (name !== propertyName) {
      continue;
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      return undefined;
    }
    return property.initializer;
  }
  return undefined;
}

function collectConfigPatchObjects(
  root: ts.ObjectLiteralExpression,
  literals: StringLiteralMap,
): ts.ObjectLiteralExpression[] {
  const patches: ts.ObjectLiteralExpression[] = [];
  walkAst(root, (node) => {
    if (!ts.isPropertyAssignment(node)) {
      return;
    }
    const propertyName = readPropertyName(node.name, literals);
    if (propertyName !== "configPatch" || !ts.isObjectLiteralExpression(node.initializer)) {
      return;
    }
    patches.push(node.initializer);
  });
  return patches;
}

function getNestedObjectProperty(
  node: ts.ObjectLiteralExpression,
  keys: readonly string[],
  literals: StringLiteralMap,
): ts.Expression | undefined {
  let current: ts.Expression | undefined = node;
  for (const key of keys) {
    if (!current || !ts.isObjectLiteralExpression(current)) {
      return undefined;
    }
    let next: ts.Expression | undefined;
    for (const property of current.properties) {
      if (!ts.isPropertyAssignment(property)) {
        continue;
      }
      const propertyName = readPropertyName(property.name, literals);
      if (propertyName !== key) {
        continue;
      }
      next = property.initializer;
      break;
    }
    current = next;
  }
  return current;
}

function readPropertyName(
  name: ts.PropertyName,
  literals?: StringLiteralMap,
): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) {
    return literals ? readStringLiteral(name.expression, literals) : undefined;
  }
  return undefined;
}

function inferSchemaFromExpression(
  node: ts.Expression,
  context: InferenceContext,
): Record<string, unknown> | undefined {
  const { literals, variables } = context;
  if (ts.isObjectLiteralExpression(node)) {
    const properties: Record<string, unknown> = {};
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spreadSchema = inferSchemaFromExpression(property.expression, context);
        const spreadProperties = asRecord(spreadSchema?.properties);
        if (spreadProperties) {
          Object.assign(properties, spreadProperties);
        }
        continue;
      }
      if (!ts.isPropertyAssignment(property)) {
        continue;
      }
      const key = readPropertyName(property.name, literals);
      if (!key) {
        continue;
      }
      const child = inferSchemaFromExpression(property.initializer, context);
      properties[key] = child ?? {};
    }
    return {
      type: "object",
      additionalProperties: true,
      properties,
    };
  }

  if (ts.isArrayLiteralExpression(node)) {
    const itemSchemas = node.elements
      .map((element) => ts.isExpression(element) ? inferSchemaFromExpression(element, context) : undefined)
      .filter((entry): entry is Record<string, unknown> => Boolean(entry));
    return {
      type: "array",
      ...(itemSchemas.length > 0 ? { items: mergeInferredSchemas(itemSchemas) } : {}),
    };
  }

  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { type: "string" };
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
    return { type: "boolean" };
  }
  if (ts.isNumericLiteral(node)) {
    return {
      type: Number.isInteger(Number(node.text)) ? "integer" : "number",
    };
  }
  if (ts.isIdentifier(node)) {
    const literal = literals.get(node.text);
    if (literal) {
      return { type: "string" };
    }
    const existing = variables.get(node.text);
    if (!existing) {
      return {};
    }
    const visiting = context.visiting ?? new Set<string>();
    if (visiting.has(node.text)) {
      return {};
    }
    const nextContext: InferenceContext = {
      ...context,
      visiting: new Set([...visiting, node.text]),
    };
    return inferSchemaFromExpression(existing, nextContext) ?? {};
  }
  if (ts.isCallExpression(node)) {
    const zodSchema = inferZodSchemaFromCall(node, context);
    if (zodSchema) {
      return zodSchema;
    }
    if (isPropertyAccessName(node.expression, "map")) {
      return {
        type: "array",
        items: {
          type: "object",
          additionalProperties: true,
        },
      };
    }
    if (isIdentifierName(node.expression, "Object.fromEntries")) {
      return {
        type: "object",
        additionalProperties: true,
      };
    }
    return {};
  }
  if (ts.isConditionalExpression(node)) {
    return mergeInferredSchemas(
      [node.whenTrue, node.whenFalse]
        .map((branch) => inferSchemaFromExpression(branch, context))
        .filter((entry): entry is Record<string, unknown> => Boolean(entry)),
    );
  }

  return {};
}

function mergeInferredSchemas(schemas: readonly Record<string, unknown>[]): Record<string, unknown> {
  if (schemas.length === 0) {
    return {};
  }
  const firstType = schemas[0]?.type;
  if (schemas.every((schema) => schema.type === firstType)) {
    if (firstType === "object") {
      const properties: Record<string, unknown> = {};
      for (const schema of schemas) {
        const candidateProps = asRecord(schema.properties) ?? {};
        for (const [key, value] of Object.entries(candidateProps)) {
          if (!(key in properties)) {
            properties[key] = value;
          }
        }
      }
      return {
        type: "object",
        additionalProperties: true,
        properties,
      };
    }
    return schemas[0];
  }
  return {};
}

function inferZodSchemaFromCall(
  node: ts.CallExpression,
  context: InferenceContext,
): Record<string, unknown> | undefined {
  if (ts.isIdentifier(node.expression) && node.expression.text === "buildChannelConfigSchema") {
    return node.arguments[0] ? inferSchemaFromExpression(node.arguments[0], context) : undefined;
  }
  if (isZodFactoryCall(node, "string")) {
    return { type: "string" };
  }
  if (isZodFactoryCall(node, "boolean")) {
    return { type: "boolean" };
  }
  if (isZodFactoryCall(node, "number")) {
    return { type: "number" };
  }
  if (isZodFactoryCall(node, "literal")) {
    const [firstArgument] = node.arguments;
    if (firstArgument && (ts.isStringLiteralLike(firstArgument) || ts.isNoSubstitutionTemplateLiteral(firstArgument))) {
      return { type: "string", const: firstArgument.text };
    }
    if (firstArgument && firstArgument.kind === ts.SyntaxKind.TrueKeyword) {
      return { type: "boolean", const: true };
    }
    if (firstArgument && firstArgument.kind === ts.SyntaxKind.FalseKeyword) {
      return { type: "boolean", const: false };
    }
    if (firstArgument && ts.isNumericLiteral(firstArgument)) {
      return { type: Number.isInteger(Number(firstArgument.text)) ? "integer" : "number", const: Number(firstArgument.text) };
    }
  }
  if (isZodFactoryCall(node, "object")) {
    return inferZodObjectSchema(node.arguments[0], context);
  }
  if (isZodFactoryCall(node, "array")) {
    const itemSchema = node.arguments[0] ? inferSchemaFromExpression(node.arguments[0], context) : undefined;
    return {
      type: "array",
      ...(itemSchema ? { items: itemSchema } : {}),
    };
  }
  if (isZodFactoryCall(node, "record")) {
    const valueArgument = node.arguments.length > 1 ? node.arguments[1] : node.arguments[0];
    return {
      type: "object",
      additionalProperties: valueArgument
        ? inferSchemaFromExpression(valueArgument, context) ?? true
        : true,
    };
  }
  if (isZodFactoryCall(node, "enum")) {
    const [firstArgument] = node.arguments;
    if (firstArgument && ts.isArrayLiteralExpression(firstArgument)) {
      const enumValues = firstArgument.elements
        .map((element) =>
          ts.isStringLiteralLike(element) || ts.isNoSubstitutionTemplateLiteral(element)
            ? element.text
            : undefined)
        .filter((value): value is string => Boolean(value));
      return enumValues.length > 0
        ? {
            type: "string",
            enum: enumValues,
          }
        : { type: "string" };
    }
    return { type: "string" };
  }
  if (isZodFactoryCall(node, "union")) {
    const [firstArgument] = node.arguments;
    if (!firstArgument || !ts.isArrayLiteralExpression(firstArgument)) {
      return {};
    }
    return {
      anyOf: firstArgument.elements
        .map((element) => ts.isExpression(element) ? inferSchemaFromExpression(element, context) : undefined)
        .filter((entry): entry is Record<string, unknown> => Boolean(entry)),
    };
  }

  if (!ts.isPropertyAccessExpression(node.expression)) {
    return undefined;
  }

  const methodName = node.expression.name.text;
  if (methodName === "string" || methodName === "boolean" || methodName === "number") {
    return inferZodSchemaFromCall(
      ts.factory.createCallExpression(
        ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier("z"), methodName),
        undefined,
        [],
      ),
      context,
    );
  }
  if (methodName === "optional" || methodName === "default" || methodName === "nullable") {
    return inferSchemaFromExpression(node.expression.expression, context);
  }
  if (methodName === "passthrough") {
    const inner = inferSchemaFromExpression(node.expression.expression, context);
    return inner && inner.type === "object"
      ? { ...inner, additionalProperties: true }
      : inner;
  }
  if (methodName === "strict") {
    const inner = inferSchemaFromExpression(node.expression.expression, context);
    return inner && inner.type === "object"
      ? { ...inner, additionalProperties: false }
      : inner;
  }
  if (methodName === "extend") {
    const base = inferSchemaFromExpression(node.expression.expression, context);
    const extension = inferZodObjectSchema(node.arguments[0], context);
    return mergeInferredSchemas(
      [base, extension].filter((entry): entry is Record<string, unknown> => Boolean(entry)),
    );
  }
  if (methodName === "min" || methodName === "max" || methodName === "url" || methodName === "int" || methodName === "positive" || methodName === "superRefine" || methodName === "refine") {
    return inferSchemaFromExpression(node.expression.expression, context);
  }

  return undefined;
}

function inferZodObjectSchema(
  node: ts.Expression | undefined,
  context: InferenceContext,
): Record<string, unknown> | undefined {
  if (!node) {
    return undefined;
  }
  if (!ts.isObjectLiteralExpression(node)) {
    return inferSchemaFromExpression(node, context);
  }

  const properties: Record<string, unknown> = {};
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spread = inferSchemaFromExpression(property.expression, context);
      const spreadProperties = asRecord(spread?.properties);
      if (spreadProperties) {
        Object.assign(properties, spreadProperties);
      }
      continue;
    }
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    const key = readPropertyName(property.name, context.literals);
    if (!key) {
      continue;
    }
    properties[key] = inferSchemaFromExpression(property.initializer, context) ?? {};
  }

  return {
    type: "object",
    additionalProperties: false,
    properties,
  };
}

function isZodFactoryCall(node: ts.CallExpression, methodName: string): boolean {
  return ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "z" &&
    node.expression.name.text === methodName;
}

function collectAssistivePathsFromExpression(
  node: ts.Expression,
  basePath: string,
  literals: StringLiteralMap,
  pathMap: Map<string, Set<string>>,
  targetId: string,
): void {
  addSurfacePath(pathMap, targetId, basePath);

  if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) {
        continue;
      }
      const key = readPropertyName(property.name, literals);
      if (!key) {
        continue;
      }
      const nextPath = `${basePath}.${key}`;
      collectAssistivePathsFromExpression(property.initializer, nextPath, literals, pathMap, targetId);
    }
    return;
  }

  if (ts.isArrayLiteralExpression(node)) {
    addSurfacePath(pathMap, targetId, basePath);
    const firstElement = node.elements.find((element): element is ts.Expression => ts.isExpression(element));
    if (firstElement) {
      collectAssistivePathsFromExpression(firstElement, `${basePath}.*`, literals, pathMap, targetId);
    }
  }
}

function ensureRecord(target: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = asRecord(target[key]);
  if (current) {
    return current;
  }
  const next: Record<string, unknown> = {};
  target[key] = next;
  return next;
}

function addSurfacePath(map: Map<string, Set<string>>, id: string, pathValue: string): void {
  const current = map.get(id) ?? new Set<string>();
  current.add(pathValue);
  map.set(id, current);
}

function mergePathMaps(
  target: Map<string, Set<string>>,
  source: Map<string, Set<string>>,
): void {
  for (const [key, values] of source) {
    const next = target.get(key) ?? new Set<string>();
    for (const value of values) {
      next.add(value);
    }
    target.set(key, next);
  }
}

function mergeSurfaceList<T extends { path: string }>(surfaces: readonly T[]): T[] {
  const next = new Map<string, T>();
  for (const surface of surfaces) {
    mergeSurface(next, surface);
  }
  return [...next.values()];
}

function mergeSurface<T extends { path: string }>(
  map: Map<string, T>,
  surface: T,
): void {
  const existing = map.get(surface.path);
  if (!existing) {
    map.set(surface.path, surface);
    return;
  }

  map.set(surface.path, mergeSurfaceRecords(existing as Record<string, unknown>, surface as Record<string, unknown>) as T);
}

function mergeSurfaceRecords(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> {
  const leftConfidence = asConfidence(left.confidence);
  const rightConfidence = asConfidence(right.confidence);
  const preferred = compareConfidence(rightConfidence, leftConfidence) >= 0 ? right : left;
  const secondary = preferred === right ? left : right;

  return {
    ...secondary,
    ...preferred,
    schema: mergeSchemas(
      asRecord(left.schema) ?? undefined,
      asRecord(right.schema) ?? undefined,
      leftConfidence === "inferred" || rightConfidence === "inferred",
    ),
    uiHints: mergeUiHintMaps(
      normalizeUiHints(left.uiHints),
      normalizeUiHints(right.uiHints),
    ),
  };
}

function mergeSchemas(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
  permissive: boolean,
): Record<string, unknown> | undefined {
  if (!left) {
    return right ? normalizeSchema(right, permissive) : undefined;
  }
  if (!right) {
    return normalizeSchema(left, permissive);
  }

  const leftNormalized = normalizeSchema(left, permissive);
  const rightNormalized = normalizeSchema(right, permissive);
  if (leftNormalized.type !== "object" || rightNormalized.type !== "object") {
    return rightNormalized;
  }

  const properties = {
    ...(asRecord(leftNormalized.properties) ?? {}),
    ...(asRecord(rightNormalized.properties) ?? {}),
  };

  return {
    ...leftNormalized,
    ...rightNormalized,
    type: "object",
    additionalProperties:
      permissive ||
      leftNormalized.additionalProperties === true ||
      rightNormalized.additionalProperties === true
        ? true
        : rightNormalized.additionalProperties ?? leftNormalized.additionalProperties,
    properties,
  };
}

function normalizeSchema(
  schema: Record<string, unknown>,
  permissive: boolean,
): Record<string, unknown> {
  if (schema.type !== "object") {
    return schema;
  }
  return {
    ...schema,
    additionalProperties:
      permissive
        ? true
        : schema.additionalProperties ?? true,
    properties: asRecord(schema.properties) ?? {},
  };
}

function mergeUiHintMaps(
  left: Record<string, Record<string, unknown>> | undefined,
  right: Record<string, Record<string, unknown>> | undefined,
): Record<string, Record<string, unknown>> | undefined {
  if (!left) {
    return right ? cloneUiHints(right) : undefined;
  }
  if (!right) {
    return cloneUiHints(left);
  }

  const next: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(left)) {
    next[key] = { ...value };
  }
  for (const [key, value] of Object.entries(right)) {
    next[key] = {
      ...(next[key] ?? {}),
      ...value,
    };
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function cloneUiHints(
  value: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const next: Record<string, Record<string, unknown>> = {};
  for (const [key, hint] of Object.entries(value)) {
    next[key] = { ...hint };
  }
  return next;
}

function stripCandidate(plugin: InstalledPluginCandidate): DiscoveredPlugin {
  return {
    id: plugin.id,
    name: plugin.name,
    description: plugin.description,
    kind: plugin.kind,
    enabled: plugin.enabled,
    status: plugin.status,
    source: plugin.source,
    origin: plugin.origin,
    configJsonSchema: plugin.configJsonSchema,
    configUiHints: plugin.configUiHints,
  };
}

function countConfidenceLevels(
  surfaces: readonly { confidence: DiscoveryConfidence }[],
): Record<DiscoveryConfidence, number> {
  return surfaces.reduce<Record<DiscoveryConfidence, number>>(
    (counts, surface) => {
      counts[surface.confidence] += 1;
      return counts;
    },
    {
      explicit: 0,
      derived: 0,
      inferred: 0,
    },
  );
}

function countSchemaBackedSurfaces(
  surfaces: readonly { confidence: DiscoveryConfidence }[],
): number {
  return surfaces.filter((surface) => surface.confidence === "explicit" || surface.confidence === "derived").length;
}

function countAssistiveOnlySurfaces(
  surfaces: readonly { confidence: DiscoveryConfidence }[],
): number {
  return surfaces.filter((surface) => surface.confidence === "inferred").length;
}

function asConfidence(value: unknown): DiscoveryConfidence {
  return value === "explicit" || value === "derived" ? value : "inferred";
}

function compareConfidence(left: DiscoveryConfidence, right: DiscoveryConfidence): number {
  return confidenceRank(left) - confidenceRank(right);
}

function confidenceRank(value: DiscoveryConfidence): number {
  switch (value) {
    case "explicit":
      return 3;
    case "derived":
      return 2;
    default:
      return 1;
  }
}

function normalizeUiHints(value: unknown): Record<string, Record<string, unknown>> | undefined {
  const hints = asRecord(value);
  if (!hints) {
    return undefined;
  }

  const normalized = Object.fromEntries(
    Object.entries(hints)
      .map(([hintPath, hintValue]) => [normalizeRelativeHintPath(hintPath), asRecord(hintValue)])
      .filter(
        (entry): entry is [string, Record<string, unknown>] =>
          Boolean(entry[0]) && Boolean(entry[1]),
      ),
  );

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeRelativeHintPath(value: string): string {
  return value.trim().replace(/^\./, "");
}

function normalizePath(value: string): string {
  return value
    .trim()
    .replace(/\[(\d+|\*)\]/g, ".$1")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+|\.+$/g, "");
}

function toPascalCase(value: string): string {
  return value
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((segment) => segment[0]?.toUpperCase() + segment.slice(1))
    .join("");
}

function toCamelCase(value: string): string {
  const pascal = toPascalCase(value);
  return pascal ? pascal[0]!.toLowerCase() + pascal.slice(1) : "";
}

function buildChannelSchemaCandidateNames(channelId: string): string[] {
  const pascal = toPascalCase(channelId);
  const camel = toCamelCase(channelId);
  return [...new Set([
    `${pascal}ConfigSchema`,
    `${pascal}ChannelConfigSchema`,
    `${camel}ConfigSchema`,
    `${camel}ChannelConfigSchema`,
  ])].filter(Boolean);
}

function collectAssistivePathsFromSchema(
  basePath: string,
  schema: Record<string, unknown>,
): string[] {
  const next = new Set<string>();
  walkSchemaPaths(schema, normalizePath(basePath), next);
  return [...next].sort((left, right) => left.localeCompare(right));
}

function walkSchemaPaths(
  schema: Record<string, unknown>,
  currentPath: string,
  output: Set<string>,
): void {
  output.add(currentPath);
  const properties = asRecord(schema.properties);
  if (properties) {
    for (const [key, value] of Object.entries(properties)) {
      const child = asRecord(value);
      if (!child) {
        continue;
      }
      walkSchemaPaths(child, `${currentPath}.${key}`, output);
    }
  }

  if (Array.isArray(schema.items)) {
    return;
  }
  const items = asRecord(schema.items);
  if (items) {
    walkSchemaPaths(items, `${currentPath}.*`, output);
  }

  const additional = asRecord(schema.additionalProperties);
  if (additional) {
    walkSchemaPaths(additional, `${currentPath}.*`, output);
  }
}

function walkAst(node: ts.Node, visitor: (node: ts.Node) => void): void {
  const visit = (current: ts.Node): void => {
    visitor(current);
    current.forEachChild(visit);
  };
  visit(node);
}

function isPropertyAccessName(
  expression: ts.LeftHandSideExpression,
  propertyName: string,
): boolean {
  return ts.isPropertyAccessExpression(expression) && expression.name.text === propertyName;
}

function isIdentifierName(expression: ts.LeftHandSideExpression, value: string): boolean {
  if (!ts.isPropertyAccessExpression(expression)) {
    return ts.isIdentifier(expression) && expression.text === value;
  }
  return expression.getText().replace(/\s+/g, "") === value.replace(/\s+/g, "");
}

function inferScriptKind(fileName: string): ts.ScriptKind {
  if (fileName.endsWith(".tsx")) {
    return ts.ScriptKind.TSX;
  }
  if (fileName.endsWith(".ts") || fileName.endsWith(".mts") || fileName.endsWith(".cts")) {
    return ts.ScriptKind.TS;
  }
  return ts.ScriptKind.JS;
}

async function readJsoncFile<T>(absolutePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(absolutePath, "utf8");
    return parse(raw) as T;
  } catch {
    return null;
  }
}

async function readdirSafe(absolutePath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(absolutePath);
    return entries;
  } catch {
    return [];
  }
}

function resolvePluginRoot(inputPath: string): string {
  const expandedPath = inputPath.startsWith("~")
    ? path.join(os.homedir(), inputPath.slice(1))
    : inputPath;
  return path.extname(expandedPath) ? path.dirname(expandedPath) : expandedPath;
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

function isObjectSchema(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
