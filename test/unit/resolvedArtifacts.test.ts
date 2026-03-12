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
          ttlHours: 6,
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
});
