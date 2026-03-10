import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionSettings } from "../extension/settings";
import type { LocalRuntimeProfileService } from "../runtime/localRuntimeProfile";
import { applyPluginOverlays } from "./pluginOverlays";
import { discoverInstalledPlugins, type PluginDiscoveryResult } from "./pluginDiscovery";
import type {
  DiscoveredPlugin,
  LocalRuntimeProfile,
  ResolvedSchemaInfo,
  ResolvedSchemaStatus,
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
  getExtensionPath: () => string;
  output: Pick<{ appendLine(value: string): void }, "appendLine">;
  runtimeProfiles: Pick<LocalRuntimeProfileService, "getProfile">;
  discoverPlugins?: typeof discoverInstalledPlugins;
};

type ResolvedSchemaBundle = {
  schemaText: string;
  uiHintsText: string;
  discovery: PluginDiscoveryResult;
  runtime: LocalRuntimeProfile;
  schemaInfo: ResolvedSchemaInfo;
};

export class ResolvedSchemaService {
  private bundlePromise: Promise<ResolvedSchemaBundle> | null = null;
  private readonly loggedMessages = new Set<string>();

  constructor(private readonly options: ResolvedArtifactsOptions) {}

  invalidate(): void {
    this.bundlePromise = null;
  }

  async getSchemaText(): Promise<string> {
    return (await this.getBundle()).schemaText;
  }

  async getUiHintsText(): Promise<string> {
    return (await this.getBundle()).uiHintsText;
  }

  async getDiscoveredPlugins(): Promise<readonly DiscoveredPlugin[]> {
    return (await this.getBundle()).discovery.plugins;
  }

  async getDiscoveryResult(): Promise<PluginDiscoveryResult> {
    return (await this.getBundle()).discovery;
  }

  async getStatus(): Promise<ResolvedSchemaStatus> {
    const [artifacts, bundle] = await Promise.all([
      this.options.artifacts.getStatus(),
      this.getBundle(),
    ]);
    return {
      artifacts,
      pluginDiscovery: bundle.discovery.status,
      runtime: bundle.runtime,
      resolvedSchema: bundle.schemaInfo,
    };
  }

  private async getBundle(): Promise<ResolvedSchemaBundle> {
    if (!this.bundlePromise) {
      this.bundlePromise = this.buildBundle();
    }
    return this.bundlePromise;
  }

  private async buildBundle(): Promise<ResolvedSchemaBundle> {
    const settings = this.options.readSettings();
    const runtime = await this.options.runtimeProfiles.getProfile({
      commandPath: settings.pluginCommandPath,
      workspaceRoot: this.options.getWorkspaceRoot(),
    });
    const requestedVersion = resolveRequestedSchemaVersion(settings.schemaVersion, runtime.versionTag);
    const [baseArtifacts, discovery] = await Promise.all([
      this.loadBaseArtifacts(requestedVersion, runtime.versionTag),
      (this.options.discoverPlugins ?? discoverInstalledPlugins)({
        commandPath: settings.pluginCommandPath,
        codeTraversalMode: settings.pluginCodeTraversal,
        workspaceRoot: this.options.getWorkspaceRoot(),
      }),
    ]);

    this.logDiscoveryStatus(discovery);
    const overlay = applyPluginOverlays(baseArtifacts.schemaText, baseArtifacts.uiHintsText, discovery);
    return {
      schemaText: overlay.schemaText,
      uiHintsText: overlay.uiHintsText,
      discovery,
      runtime,
      schemaInfo: {
        requestedVersion,
        resolvedVersion: baseArtifacts.resolvedVersion,
        source: baseArtifacts.source,
        versionMatched: Boolean(runtime.versionTag && baseArtifacts.resolvedVersion === runtime.versionTag),
      },
    };
  }

  private async loadBaseArtifacts(
    requestedVersion: string,
    runtimeVersion?: string,
  ): Promise<{
    schemaText: string;
    uiHintsText: string;
    resolvedVersion?: string;
    source: "bundled-versioned" | "live-artifacts";
  }> {
    const bundledVersion = await readBundledVersionedArtifacts(
      this.options.getExtensionPath(),
      runtimeVersion && requestedVersion === runtimeVersion ? runtimeVersion : requestedVersion,
    );
    if (bundledVersion) {
      return {
        ...bundledVersion,
        source: "bundled-versioned",
      };
    }

    const [schemaText, uiHintsText] = await Promise.all([
      this.options.artifacts.getSchemaText(),
      this.options.artifacts.getUiHintsText(),
    ]);
    return {
      schemaText,
      uiHintsText,
      resolvedVersion: requestedVersion === "latest" ? runtimeVersion : requestedVersion,
      source: "live-artifacts",
    };
  }

  private logDiscoveryStatus(discovery: PluginDiscoveryResult): void {
    const { status } = discovery;
    if (status.source === "cli") {
      return;
    }

    const message =
      status.source === "manifest-fallback"
        ? `[plugins] Local plugin discovery fell back to manifest scanning: ${status.lastError ?? "unknown error"}`
        : `[plugins] Local plugin discovery unavailable: ${status.lastError ?? "unknown error"}`;

    if (this.loggedMessages.has(message)) {
      return;
    }
    this.loggedMessages.add(message);
    this.options.output.appendLine(message);
    if (status.lastTraversalError) {
      this.options.output.appendLine(
        `[plugins] Local code traversal degraded: ${status.lastTraversalError}`,
      );
    }
  }
}

async function readBundledVersionedArtifacts(
  extensionPath: string,
  versionTag: string,
): Promise<{
  schemaText: string;
  uiHintsText: string;
  resolvedVersion: string;
} | null> {
  const normalized = versionTag.trim();
  if (!normalized || normalized === "latest") {
    return null;
  }

  const root = path.join(extensionPath, "schemas", normalized);
  const schemaPath = path.join(root, "openclaw.schema.json");
  const uiHintsPath = path.join(root, "openclaw.ui-hints.json");

  if (!(await exists(schemaPath)) || !(await exists(uiHintsPath))) {
    return null;
  }

  const [schemaText, uiHintsText] = await Promise.all([
    fs.readFile(schemaPath, "utf8"),
    fs.readFile(uiHintsPath, "utf8"),
  ]);
  return {
    schemaText,
    uiHintsText,
    resolvedVersion: normalized,
  };
}

async function exists(absolutePath: string): Promise<boolean> {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

function resolveRequestedSchemaVersion(schemaVersion: string, runtimeVersion?: string): string {
  const normalized = schemaVersion.trim();
  if (normalized && normalized !== "latest") {
    return normalized;
  }
  return runtimeVersion ?? "latest";
}
