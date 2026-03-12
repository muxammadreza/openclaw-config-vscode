import type { ExtensionSettings } from "../extension/settings";
import type { LocalRuntimeProfileService } from "../runtime/localRuntimeProfile";
import { OpenClawGatewaySchemaClient } from "./gatewaySchema";
import { discoverInstalledPlugins, type PluginDiscoveryResult } from "./pluginDiscovery";
import { applyPluginOverlays } from "./pluginOverlays";
import type {
  DiscoveredPlugin,
  LocalRuntimeProfile,
  ResolvedRuntimeSchemaSnapshot,
  ResolvedSchemaStatus,
  SchemaLookupResult,
  SchemaPreferredSource,
  SchemaResolutionSource,
  SchemaStatus,
} from "./types";

type ArtifactReader = {
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
  now?: () => number;
};

type ResolvedSchemaBundle = {
  snapshot: ResolvedRuntimeSchemaSnapshot;
  runtime: LocalRuntimeProfile;
  requestedVersion: string;
};

const BUNDLE_TTL_MS = 5_000;
const DISCOVERY_TTL_MS = 30_000;

export class ResolvedSchemaService {
  private bundleCache: { builtAt: number; value: Promise<ResolvedSchemaBundle> } | null = null;
  private discoveryCache: { builtAt: number; value: Promise<PluginDiscoveryResult> } | null = null;
  private readonly loggedMessages = new Set<string>();
  private readonly gatewayLookupClient = new OpenClawGatewaySchemaClient({
    timeoutMs: 3_000,
  });
  private readonly gatewayResolutionClient = new OpenClawGatewaySchemaClient({
    timeoutMs: 2_500,
  });

  constructor(private readonly options: ResolvedArtifactsOptions) {}

  invalidate(): void {
    this.bundleCache = null;
    this.discoveryCache = null;
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
    const now = (this.options.now ?? (() => Date.now()))();
    if (this.bundleCache && now - this.bundleCache.builtAt < BUNDLE_TTL_MS) {
      return this.bundleCache.value;
    }

    this.bundleCache = {
      builtAt: now,
      value: this.buildBundle(),
    };
    return this.bundleCache.value;
  }

  private async getDiscovery(): Promise<PluginDiscoveryResult> {
    const now = (this.options.now ?? (() => Date.now()))();
    if (this.discoveryCache && now - this.discoveryCache.builtAt < DISCOVERY_TTL_MS) {
      return this.discoveryCache.value;
    }

    this.discoveryCache = {
      builtAt: now,
      value: this.buildDiscovery(),
    };
    return this.discoveryCache.value;
  }

  private async buildBundle(): Promise<ResolvedSchemaBundle> {
    const settings = this.options.readSettings();
    const runtime = await this.options.runtimeProfiles.getProfile({
      commandPath: settings.pluginCommandPath,
      workspaceRoot: this.options.getWorkspaceRoot(),
    });
    const requestedVersion = resolveRequestedSchemaVersion(settings.schemaVersion, runtime.versionTag);
    const snapshot = await this.resolveSchemaSnapshot({
      settings,
      runtime,
      requestedVersion,
    });

    return {
      snapshot,
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
          const discovery = await this.getDiscovery();
          const [schemaText, uiHintsText] = await Promise.all([
            this.options.artifacts.getSchemaText(),
            this.options.artifacts.getUiHintsText(),
          ]);
          const overlay = applyPluginOverlays(schemaText, uiHintsText, discovery);
          return {
            schemaText: overlay.schemaText,
            uiHintsText: overlay.uiHintsText,
            openclawVersion: normalizeVersionNumber(params.requestedVersion),
            source: "remote-versioned",
            capabilities: {
              gatewaySchema: false,
              gatewaySchemaLookup: false,
              runtimeValidateJson: params.runtime.validatorSupportsJson,
              pluginListJson: discovery.status.source === "cli",
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
