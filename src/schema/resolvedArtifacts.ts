import type { ExtensionSettings } from "../extension/settings";
import type { LocalRuntimeProfileService } from "../runtime/localRuntimeProfile";
import { computePluginDiscoveryFingerprint, computeResolvedSnapshotCacheKey } from "./fingerprint";
import { OpenClawGatewaySchemaClient } from "./gatewaySchema";
import { discoverInstalledPlugins, type PluginDiscoveryResult } from "./pluginDiscovery";
import { applyPluginOverlays } from "./pluginOverlays";
import { ResolvedSnapshotStore } from "./resolvedSnapshotStore";
import type {
  DiscoveredPlugin,
  LocalRuntimeProfile,
  PersistedResolvedRuntimeSchemaSnapshot,
  ResolvedRuntimeSchemaSnapshot,
  ResolvedSchemaStatus,
  SchemaLookupResult,
  SchemaPreferredSource,
  SchemaResolutionSource,
  SchemaStatus,
} from "./types";

type ArtifactReader = {
  ensureCached?: (force: boolean) => Promise<unknown>;
  getSchemaText: () => Promise<string>;
  getUiHintsText: () => Promise<string>;
  getStatus: () => Promise<SchemaStatus>;
};

type ResolvedArtifactsOptions = {
  artifacts: ArtifactReader;
  readSettings: () => ExtensionSettings;
  getWorkspaceRoot: () => string | undefined;
  output: Pick<{ appendLine(value: string): void }, "appendLine">;
  runtimeProfiles: Pick<LocalRuntimeProfileService, "getProfile">;
  discoverPlugins?: typeof discoverInstalledPlugins;
  snapshotStore?: Pick<ResolvedSnapshotStore, "load" | "save" | "clear">;
  now?: () => number;
};

type ResolvedSchemaBundle = {
  snapshot: ResolvedRuntimeSchemaSnapshot;
  discovery: PluginDiscoveryResult;
  runtime: LocalRuntimeProfile;
  requestedVersion: string;
};

export class ResolvedSchemaService {
  private bundleCache: Promise<ResolvedSchemaBundle> | null = null;
  private discoveryCache: Promise<PluginDiscoveryResult> | null = null;
  private readonly loggedMessages = new Set<string>();
  private readonly gatewayLookupClient = new OpenClawGatewaySchemaClient({
    timeoutMs: 3_000,
  });
  private readonly gatewayResolutionClient = new OpenClawGatewaySchemaClient({
    timeoutMs: 2_500,
  });
  private readonly snapshotStore: Pick<ResolvedSnapshotStore, "load" | "save" | "clear"> | null;

  constructor(private readonly options: ResolvedArtifactsOptions) {
    this.snapshotStore = options.snapshotStore ?? null;
  }

  invalidate(): void {
    this.bundleCache = null;
    this.discoveryCache = null;
  }

  async clearPersistentCache(): Promise<void> {
    await this.snapshotStore?.clear();
    this.invalidate();
  }

  async ensureSnapshot(forceRebuild: boolean): Promise<{ updated: boolean; message: string }> {
    if (forceRebuild) {
      await this.clearPersistentCache();
    }
    await this.getBundleInternal(forceRebuild);
    return {
      updated: forceRebuild,
      message: forceRebuild
        ? "Rebuilt resolved OpenClaw schema snapshot."
        : "Loaded resolved OpenClaw schema snapshot.",
    };
  }

  async getSchemaText(): Promise<string> {
    return (await this.getBundle()).snapshot.schemaText;
  }

  async getUiHintsText(): Promise<string> {
    return (await this.getBundle()).snapshot.uiHintsText;
  }

  async getDiscoveredPlugins(): Promise<readonly DiscoveredPlugin[]> {
    return (await this.getDiscovery()).plugins;
  }

  async getDiscoveryResult(): Promise<PluginDiscoveryResult> {
    return this.getDiscovery();
  }

  async getSchemaLookup(pathExpression: string): Promise<SchemaLookupResult | null> {
    const bundle = await this.getBundle();
    if (!bundle.snapshot.capabilities.gatewaySchemaLookup) {
      return null;
    }
    try {
      return await this.gatewayLookupClient.lookupSchemaPath(
        bundle.runtime.commandPath,
        pathExpression,
        this.options.getWorkspaceRoot(),
      );
    } catch (error) {
      this.logOnce(`[schema] Gateway schema lookup failed: ${toErrorMessage(error)}`);
      return null;
    }
  }

  async getStatus(): Promise<ResolvedSchemaStatus> {
    const [artifacts, bundle, discovery] = await Promise.all([
      this.options.artifacts.getStatus(),
      this.getBundle(),
      this.getDiscovery(),
    ]);
    return {
      artifacts,
      pluginDiscovery: discovery.status,
      runtime: bundle.runtime,
      resolvedSchema: {
        requestedVersion: bundle.requestedVersion,
        resolvedVersion: bundle.snapshot.openclawVersion
          ? normalizeVersionTag(bundle.snapshot.openclawVersion)
          : bundle.requestedVersion,
        source: bundle.snapshot.source,
        versionMatched: isVersionMatch(bundle.runtime.versionTag, bundle.snapshot.openclawVersion),
        openclawCommit: bundle.snapshot.openclawCommit,
        generatedAt: bundle.snapshot.generatedAt,
        warnings: [...bundle.snapshot.warnings],
        capabilities: {
          ...bundle.snapshot.capabilities,
          pluginListJson: discovery.status.source === "cli",
        },
      },
    };
  }

  private async getBundle(): Promise<ResolvedSchemaBundle> {
    return this.getBundleInternal(false);
  }

  private async getBundleInternal(forceRebuild: boolean): Promise<ResolvedSchemaBundle> {
    if (!forceRebuild && this.bundleCache) {
      return this.bundleCache;
    }

    this.bundleCache = this.buildBundle();
    return this.bundleCache;
  }

  private async getDiscovery(): Promise<PluginDiscoveryResult> {
    if (this.discoveryCache) {
      return this.discoveryCache;
    }

    this.discoveryCache = this.buildDiscovery();
    return this.discoveryCache;
  }

  private async buildBundle(): Promise<ResolvedSchemaBundle> {
    const settings = this.options.readSettings();
    const runtime = await this.options.runtimeProfiles.getProfile({
      commandPath: settings.pluginCommandPath,
      workspaceRoot: this.options.getWorkspaceRoot(),
    });
    const discovery = await this.getDiscovery();
    const requestedVersion = resolveRequestedSchemaVersion(settings.schemaVersion, runtime.versionTag);
    const sourceIdentity = [
      settings.manifestUrl.trim(),
      requestedVersion,
      settings.schemaPreferredSource,
    ].join("|");
    const pluginFingerprint = computePluginDiscoveryFingerprint(discovery);
    const cacheKey = computeResolvedSnapshotCacheKey({
      openclawVersion: runtime.versionTag ?? requestedVersion,
      pluginFingerprint,
      sourceIdentity,
      preferredSource: settings.schemaPreferredSource,
    });
    const persisted = await this.snapshotStore?.load(cacheKey);
    if (persisted) {
      return {
        snapshot: persisted.snapshot,
        discovery: persisted.discovery,
        runtime,
        requestedVersion,
      };
    }

    const snapshot = await this.resolveSchemaSnapshot({
      settings,
      runtime,
      discovery,
      requestedVersion,
    });
    await this.snapshotStore?.save(this.toPersistedSnapshot({
      cacheKey,
      pluginFingerprint,
      sourceIdentity,
      snapshot,
      discovery,
    }));

    return {
      snapshot,
      discovery,
      runtime,
      requestedVersion,
    };
  }

  private async buildDiscovery(): Promise<PluginDiscoveryResult> {
    const settings = this.options.readSettings();
    const runtime = await this.options.runtimeProfiles.getProfile({
      commandPath: settings.pluginCommandPath,
      workspaceRoot: this.options.getWorkspaceRoot(),
    });
    const discovery = await (this.options.discoverPlugins ?? discoverInstalledPlugins)({
      commandPath: settings.pluginCommandPath,
      workspaceRoot: this.options.getWorkspaceRoot(),
      configPath: runtime.configPath,
    });
    this.logDiscoveryStatus(discovery);
    return discovery;
  }

  private async resolveSchemaSnapshot(params: {
    settings: ExtensionSettings;
    runtime: LocalRuntimeProfile;
    discovery: PluginDiscoveryResult;
    requestedVersion: string;
  }): Promise<ResolvedRuntimeSchemaSnapshot> {
    const warnings: string[] = [];
    const preferredSource = params.settings.schemaPreferredSource;
    const order = getResolutionOrder(preferredSource);

    for (const candidate of order) {
      try {
        if (candidate === "gateway-rpc" && params.runtime.available) {
          const payload = await this.gatewayResolutionClient.getSchema(
            params.runtime.commandPath,
            this.options.getWorkspaceRoot(),
          );
          return {
            schemaText: JSON.stringify(payload.schema, null, 2),
            uiHintsText: JSON.stringify(payload.uiHints, null, 2),
            openclawVersion: payload.version ?? params.runtime.version,
            generatedAt: payload.generatedAt,
            source: "gateway-rpc",
            capabilities: {
              gatewaySchema: true,
              gatewaySchemaLookup: true,
              runtimeValidateJson: params.runtime.validatorSupportsJson,
              pluginListJson: false,
              remoteVersionedFallback: true,
            },
            warnings,
          };
        }

        if (candidate === "remote-versioned") {
          await this.options.artifacts.ensureCached?.(false);
          const [schemaText, uiHintsText] = await Promise.all([
            this.options.artifacts.getSchemaText(),
            this.options.artifacts.getUiHintsText(),
          ]);
          const overlay = applyPluginOverlays(schemaText, uiHintsText, params.discovery);
          return {
            schemaText: overlay.schemaText,
            uiHintsText: overlay.uiHintsText,
            openclawVersion: normalizeVersionNumber(params.requestedVersion),
            source: "remote-versioned",
            capabilities: {
              gatewaySchema: false,
              gatewaySchemaLookup: false,
              runtimeValidateJson: params.runtime.validatorSupportsJson,
              pluginListJson: params.discovery.status.source === "cli",
              remoteVersionedFallback: true,
            },
            warnings,
          };
        }
      } catch (error) {
        warnings.push(`${candidate}: ${toErrorMessage(error)}`);
      }
    }

    throw new Error("Unable to resolve any OpenClaw schema source.");
  }

  private logDiscoveryStatus(discovery: PluginDiscoveryResult): void {
    if (discovery.status.source === "cli") {
      return;
    }

    const message =
      discovery.status.source === "manifest-fallback"
        ? `[plugins] Local plugin discovery fell back to manifest scanning: ${discovery.status.lastError ?? "unknown error"}`
        : `[plugins] Local plugin discovery unavailable: ${discovery.status.lastError ?? "unknown error"}`;
    this.logOnce(message);

    for (const warning of discovery.status.warnings ?? []) {
      this.logOnce(`[plugins] ${warning}`);
    }
  }

  private logOnce(message: string): void {
    if (this.loggedMessages.has(message)) {
      return;
    }
    this.loggedMessages.add(message);
    this.options.output.appendLine(message);
  }

  private toPersistedSnapshot(params: {
    cacheKey: string;
    pluginFingerprint: string;
    sourceIdentity: string;
    snapshot: ResolvedRuntimeSchemaSnapshot;
    discovery: PluginDiscoveryResult;
  }): PersistedResolvedRuntimeSchemaSnapshot {
    return {
      metadata: {
        cacheKey: params.cacheKey,
        pluginFingerprint: params.pluginFingerprint,
        sourceIdentity: params.sourceIdentity,
        storedAt: new Date((this.options.now ?? (() => Date.now()))()).toISOString(),
      },
      snapshot: params.snapshot,
      discovery: params.discovery,
    };
  }
}

function resolveRequestedSchemaVersion(schemaVersion: string, runtimeVersion?: string): string {
  const normalized = normalizeVersionTag(schemaVersion.trim());
  if (normalized && normalized !== "latest") {
    return normalized;
  }
  return runtimeVersion ?? "latest";
}

function getResolutionOrder(preferredSource: SchemaPreferredSource): SchemaResolutionSource[] {
  switch (preferredSource) {
    case "gateway":
      return ["gateway-rpc", "remote-versioned"];
    case "remote":
      return ["remote-versioned", "gateway-rpc"];
    default:
      return ["gateway-rpc", "remote-versioned"];
  }
}

function normalizeVersionTag(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "latest") {
    return trimmed;
  }
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

function normalizeVersionNumber(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.startsWith("v") ? value.slice(1) : value;
}

function isVersionMatch(runtimeVersionTag: string | undefined, resolvedVersion: string | undefined): boolean {
  if (!runtimeVersionTag || !resolvedVersion) {
    return false;
  }
  return normalizeVersionTag(runtimeVersionTag) === normalizeVersionTag(resolvedVersion);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
