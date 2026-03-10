import type { ExtensionSettings } from "../extension/settings";
import { applyPluginOverlays } from "./pluginOverlays";
import { discoverInstalledPlugins, type PluginDiscoveryResult } from "./pluginDiscovery";
import type {
  DiscoveredPlugin,
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
  output: Pick<{ appendLine(value: string): void }, "appendLine">;
};

type ResolvedSchemaBundle = {
  schemaText: string;
  uiHintsText: string;
  discovery: PluginDiscoveryResult;
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

  async getStatus(): Promise<ResolvedSchemaStatus> {
    const [artifacts, bundle] = await Promise.all([
      this.options.artifacts.getStatus(),
      this.getBundle(),
    ]);
    return {
      artifacts,
      pluginDiscovery: bundle.discovery.status,
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
    const [schemaText, uiHintsText, discovery] = await Promise.all([
      this.options.artifacts.getSchemaText(),
      this.options.artifacts.getUiHintsText(),
      discoverInstalledPlugins({
        commandPath: settings.pluginCommandPath,
        workspaceRoot: this.options.getWorkspaceRoot(),
      }),
    ]);

    this.logDiscoveryStatus(discovery);
    const overlay = applyPluginOverlays(schemaText, uiHintsText, discovery.plugins);
    return {
      schemaText: overlay.schemaText,
      uiHintsText: overlay.uiHintsText,
      discovery,
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
  }
}
