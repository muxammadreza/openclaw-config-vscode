import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { ExtensionSettings } from "../../src/extension/settings";
import type { PluginDiscoveryResult } from "../../src/schema/pluginDiscovery";
import { ResolvedSchemaService } from "../../src/schema/resolvedArtifacts";

describe("resolved artifacts", () => {
  it("uses remote versioned fallback when gateway is unavailable", async () => {
    const service = new ResolvedSchemaService({
      artifacts: {
        getSchemaText: async () => JSON.stringify({ title: "remote-versioned" }, null, 2),
        getUiHintsText: async () => JSON.stringify({ gateway: { label: "Gateway" } }, null, 2),
        getStatus: async () => ({
          source: "cache",
          manifestUrl: "https://example.test/manifest.json",
          policy: {
            manifest: {
              allowed: true,
              reason: "ok",
            },
            artifacts: [],
          },
        }),
      },
      output: {
        appendLine: () => {},
      },
      readSettings: () =>
        ({
          strictSecrets: false,
          explainOnHover: true,
          manifestUrl: "https://example.test/manifest.json",
          allowedHosts: ["example.test"],
          allowedRepositories: ["*"],
          pluginMetadataUrl: "",
          pluginMetadataLocalPath: ".openclaw/plugin-hints.json",
          pluginCommandPath: "openclaw",
          codeActionsEnabled: true,
          schemaVersion: "latest",
          schemaPreferredSource: "remote",
          autoUpdate: false,
        }) satisfies ExtensionSettings,
      getWorkspaceRoot: () => undefined,
      runtimeProfiles: {
        getProfile: async () => ({
          commandPath: "openclaw",
          available: false,
          version: "2026.3.8",
          versionTag: "v2026.3.8",
          validatorSupportsJson: true,
        }),
      },
      discoverPlugins: async () =>
        ({
          plugins: [],
          pluginSurfaces: [],
          channelSurfaces: [],
          providerSurfaces: [],
          status: {
            source: "unavailable",
            commandPath: "openclaw",
            pluginCount: 0,
            channelCount: 0,
            providerCount: 0,
            schemaBackedSurfaceCount: 0,
            assistiveOnlySurfaceCount: 0,
            confidence: {
              explicit: 0,
              derived: 0,
              inferred: 0,
            },
            authoritative: false,
            warnings: [],
          },
        }) satisfies PluginDiscoveryResult,
    });

    assert.equal(await service.getSchemaText(), '{\n  "title": "remote-versioned"\n}');

    const status = await service.getStatus();
    assert.equal(status.resolvedSchema.resolvedVersion, "v2026.3.8");
    assert.equal(status.resolvedSchema.source, "remote-versioned");
    assert.equal(status.resolvedSchema.capabilities.remoteVersionedFallback, true);
  });

  it("reuses the resolved snapshot without re-running discovery or remote artifact reads", async () => {
    let schemaReads = 0;
    let uiHintsReads = 0;
    let discoveryRuns = 0;

    const service = createService({
      artifacts: {
        getSchemaText: async () => {
          schemaReads += 1;
          return JSON.stringify({ title: "remote-versioned" }, null, 2);
        },
        getUiHintsText: async () => {
          uiHintsReads += 1;
          return JSON.stringify({ gateway: { label: "Gateway" } }, null, 2);
        },
      },
      discoverPlugins: async () => {
        discoveryRuns += 1;
        return emptyDiscovery();
      },
    });

    assert.equal(await service.getSchemaText(), '{\n  "title": "remote-versioned"\n}');
    assert.equal(await service.getSchemaText(), '{\n  "title": "remote-versioned"\n}');
    assert.equal((await service.getUiHintsText()).includes("Gateway"), true);

    assert.equal(schemaReads, 1);
    assert.equal(uiHintsReads, 1);
    assert.equal(discoveryRuns, 1);
  });

  it("rebuilds the resolved snapshot when the runtime version changes after invalidation", async () => {
    let schemaReads = 0;
    let runtimeVersionTag = "v2026.3.8";

    const service = createService({
      artifacts: {
        getSchemaText: async () => {
          schemaReads += 1;
          return JSON.stringify({ title: runtimeVersionTag }, null, 2);
        },
      },
      runtimeProfiles: {
        getProfile: async () => ({
          commandPath: "openclaw",
          available: false,
          version: runtimeVersionTag.slice(1),
          versionTag: runtimeVersionTag,
          validatorSupportsJson: true,
        }),
      },
    });

    assert.equal(await service.getSchemaText(), '{\n  "title": "v2026.3.8"\n}');
    runtimeVersionTag = "v2026.3.9";
    service.invalidate();
    assert.equal(await service.getSchemaText(), '{\n  "title": "v2026.3.9"\n}');
    assert.equal(schemaReads, 2);
  });
});

function createService(overrides: {
  artifacts?: Partial<{
    ensureCached: (force: boolean) => Promise<unknown>;
    getSchemaText: () => Promise<string>;
    getUiHintsText: () => Promise<string>;
    getStatus: () => Promise<{
      source: "cache";
      manifestUrl: string;
      policy: {
        manifest: {
          allowed: boolean;
          reason: string;
        };
        artifacts: never[];
      };
    }>;
  }>;
  runtimeProfiles?: Partial<{
    getProfile: () => Promise<{
      commandPath: string;
      available: boolean;
      version: string;
      versionTag: string;
      validatorSupportsJson: boolean;
    }>;
  }>;
  discoverPlugins?: () => Promise<PluginDiscoveryResult>;
} = {}) {
  const store = new Map<string, unknown>();

  return new ResolvedSchemaService({
    artifacts: {
      ensureCached: async () => undefined,
      getSchemaText: async () => JSON.stringify({ title: "remote-versioned" }, null, 2),
      getUiHintsText: async () => JSON.stringify({ gateway: { label: "Gateway" } }, null, 2),
      getStatus: async () => ({
        source: "cache",
        manifestUrl: "https://example.test/manifest.json",
        policy: {
          manifest: {
            allowed: true,
            reason: "ok",
          },
          artifacts: [],
        },
      }),
      ...overrides.artifacts,
    },
    output: {
      appendLine: () => {},
    },
    readSettings: () =>
      ({
        strictSecrets: false,
        explainOnHover: true,
        manifestUrl: "https://example.test/manifest.json",
        allowedHosts: ["example.test"],
        allowedRepositories: ["*"],
        pluginMetadataUrl: "",
        pluginMetadataLocalPath: ".openclaw/plugin-hints.json",
        pluginCommandPath: "openclaw",
        codeActionsEnabled: true,
        schemaVersion: "latest",
        schemaPreferredSource: "remote",
        autoUpdate: false,
      }) satisfies ExtensionSettings,
    getWorkspaceRoot: () => undefined,
    runtimeProfiles: {
      getProfile: async () => ({
        commandPath: "openclaw",
        available: false,
        version: "2026.3.8",
        versionTag: "v2026.3.8",
        validatorSupportsJson: true,
      }),
      ...overrides.runtimeProfiles,
    },
    discoverPlugins: overrides.discoverPlugins ?? emptyDiscovery,
    snapshotStore: {
      load: async (cacheKey) => (store.get(cacheKey) as any) ?? null,
      save: async (snapshot) => {
        store.set(snapshot.metadata.cacheKey, snapshot);
      },
      clear: async () => {
        store.clear();
      },
    },
  });
}

function emptyDiscovery(): PluginDiscoveryResult {
  return {
    plugins: [],
    pluginSurfaces: [],
    channelSurfaces: [],
    providerSurfaces: [],
    status: {
      source: "unavailable",
      commandPath: "openclaw",
      pluginCount: 0,
      channelCount: 0,
      providerCount: 0,
      schemaBackedSurfaceCount: 0,
      assistiveOnlySurfaceCount: 0,
      confidence: {
        explicit: 0,
        derived: 0,
        inferred: 0,
      },
      authoritative: false,
      warnings: [],
    },
  };
}
