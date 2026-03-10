import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import type { ExtensionSettings } from "../../src/extension/settings";
import type { PluginDiscoveryResult } from "../../src/schema/pluginDiscovery";
import { ResolvedSchemaService } from "../../src/schema/resolvedArtifacts";

const createdDirs: string[] = [];

describe("resolved artifacts", () => {
  afterEach(async () => {
    await Promise.all(createdDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("prefers bundled versioned schema when the local runtime version is known", async () => {
    const extensionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-resolved-artifacts-"));
    createdDirs.push(extensionRoot);

    const bundledRoot = path.join(extensionRoot, "schemas", "v2026.3.8");
    await fs.mkdir(bundledRoot, { recursive: true });
    await fs.writeFile(
      path.join(bundledRoot, "openclaw.schema.json"),
      JSON.stringify({ title: "bundled-versioned" }, null, 2),
      "utf8",
    );
    await fs.writeFile(
      path.join(bundledRoot, "openclaw.ui-hints.json"),
      JSON.stringify({ gateway: { label: "Gateway" } }, null, 2),
      "utf8",
    );

    const service = new ResolvedSchemaService({
      artifacts: {
        getSchemaText: async () => JSON.stringify({ title: "live-artifacts" }, null, 2),
        getUiHintsText: async () => JSON.stringify({ gateway: { label: "Live" } }, null, 2),
        getStatus: async () => ({
          source: "bundled",
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
          zodShadowEnabled: true,
          strictSecrets: false,
          explainOnHover: true,
          manifestUrl: "https://example.test/manifest.json",
          allowedHosts: ["example.test"],
          allowedRepositories: ["*"],
          pluginMetadataUrl: "",
          pluginMetadataLocalPath: ".openclaw/plugin-hints.json",
          pluginCommandPath: "openclaw",
          pluginCodeTraversal: "off",
          codeActionsEnabled: true,
          schemaVersion: "latest",
          autoUpdate: false,
        }) satisfies ExtensionSettings,
      getWorkspaceRoot: () => undefined,
      getExtensionPath: () => extensionRoot,
      runtimeProfiles: {
        getProfile: async () => ({
          commandPath: "openclaw",
          available: true,
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
            codeTraversalMode: "off",
            confidence: {
              explicit: 0,
              derived: 0,
              inferred: 0,
            },
          },
        }) satisfies PluginDiscoveryResult,
    });

    assert.equal(await service.getSchemaText(), '{\n  "title": "bundled-versioned"\n}');

    const status = await service.getStatus();
    assert.equal(status.resolvedSchema.resolvedVersion, "v2026.3.8");
    assert.equal(status.resolvedSchema.source, "bundled-versioned");
    assert.equal(status.resolvedSchema.versionMatched, true);
  });
});
