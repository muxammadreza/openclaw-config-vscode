import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { evaluatePluginValidationIssues } from "../../src/validation/pluginRules";

describe("plugin validation rules", () => {
  it("flags missing allowlist and slot plugin ids", () => {
    const issues = evaluatePluginValidationIssues(
      {
        plugins: {
          allow: ["memu-engine", "ghost-plugin"],
          slots: {
            memory: "ghost-plugin",
            contextEngine: "legacy",
          },
        },
      },
      {
        plugins: [
          {
            id: "memu-engine",
            kind: "memory",
            enabled: true,
          },
        ],
        channelSurfaces: [],
        providerSurfaces: [],
      },
    );

    assert.equal(issues.some((issue) => issue.code === "plugin-allow-missing"), true);
    assert.equal(issues.some((issue) => issue.code === "plugin-slot-memory-missing"), true);
    assert.equal(
      issues.some((issue) => issue.code === "plugin-slot-context-engine-missing"),
      false,
    );
  });

  it("warns for stale plugin entries and disabled plugin config", () => {
    const issues = evaluatePluginValidationIssues(
      {
        plugins: {
          entries: {
            "ghost-plugin": {
              enabled: true,
            },
            "memu-engine": {
              config: {
                embedding: {
                  provider: "openai",
                },
              },
            },
          },
        },
      },
      {
        plugins: [
          {
            id: "memu-engine",
            enabled: false,
          },
        ],
        channelSurfaces: [],
        providerSurfaces: [],
      },
    );

    assert.equal(issues.some((issue) => issue.code === "plugin-entry-missing"), true);
    assert.equal(issues.some((issue) => issue.code === "plugin-disabled-config"), true);
  });

  it("warns for undiscoverable channels but keeps providers user-extensible", () => {
    const issues = evaluatePluginValidationIssues(
      {
        channels: {
          telegram: {
            token: "secret",
          },
          ghostchannel: {
            enabled: true,
          },
        },
        models: {
          providers: {
            openai: {
              apiKey: "ok",
            },
            "copilot-proxy": {
              baseUrl: "http://localhost:3000/v1",
            },
            "ghost-provider": {
              enabled: true,
            },
          },
        },
      },
      {
        plugins: [],
        channelSurfaces: [
          {
            kind: "channel",
            id: "telegram",
            path: "channels.telegram",
            source: "bundled-sdk",
            confidence: "derived",
            originPluginId: "telegram",
          },
        ],
        providerSurfaces: [
          {
            kind: "provider",
            id: "copilot-proxy",
            path: "models.providers.copilot-proxy",
            source: "code-ast",
            confidence: "inferred",
            originPluginId: "copilot-proxy",
          },
        ],
      },
    );

    assert.equal(issues.some((issue) => issue.code === "channel-entry-missing"), true);
    assert.equal(
      issues.some((issue) => issue.path === "models.providers.openai"),
      false,
    );
    assert.equal(
      issues.some((issue) => issue.path === "models.providers.ghost-provider"),
      false,
    );
  });
});
