import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { applyPluginOverlays } from "../../src/schema/pluginOverlays";

describe("plugin overlays", () => {
  it("adds plugin, channel, and provider overlays with slot enums", () => {
    const baseSchema = JSON.stringify({
      type: "object",
      properties: {
        models: {
          type: "object",
          properties: {
            providers: {
              type: "object",
              additionalProperties: {
                type: "object",
                additionalProperties: false,
                properties: {
                  baseUrl: {
                    type: "string",
                    minLength: 1,
                  },
                  models: {
                    type: "array",
                  },
                },
              },
            },
          },
        },
        channels: {
          type: "object",
          additionalProperties: true,
          properties: {},
        },
        plugins: {
          type: "object",
          properties: {
            allow: {
              type: "array",
              items: { type: "string" },
            },
            deny: {
              type: "array",
              items: { type: "string" },
            },
            slots: {
              type: "object",
              properties: {
                memory: { type: "string" },
                contextEngine: { type: "string" },
              },
            },
            entries: {
              type: "object",
              additionalProperties: {
                type: "object",
                properties: {
                  enabled: { type: "boolean" },
                  config: {
                    type: "object",
                    propertyNames: { type: "string" },
                    additionalProperties: {},
                  },
                },
              },
            },
          },
        },
      },
    });
    const baseUiHints = JSON.stringify({
      "plugins.entries.*.config": {
        label: "Plugin Config",
      },
    });

    const overlay = applyPluginOverlays(baseSchema, baseUiHints, {
      plugins: [
        {
          id: "memu-engine",
          name: "memU Agentic Engine",
          description: "Memory plugin",
          kind: "memory",
          configJsonSchema: {
            type: "object",
            properties: {
              embedding: {
                type: "object",
              },
            },
          },
          configUiHints: {
            embedding: {
              label: "Embedding",
            },
          },
        },
        {
          id: "lossless-claw",
          name: "Lossless Context Management",
          kind: "context-engine",
          configJsonSchema: {
            type: "object",
            properties: {
              dbPath: {
                type: "string",
              },
            },
          },
        },
      ],
      pluginSurfaces: [
        {
          kind: "plugin",
          id: "memu-engine",
          path: "plugins.entries.memu-engine.config",
          source: "cli",
          confidence: "explicit",
          originPluginId: "memu-engine",
          label: "memU Agentic Engine",
          description: "Memory plugin",
          schema: {
            type: "object",
            properties: {
              embedding: {
                type: "object",
              },
            },
          },
          uiHints: {
            embedding: {
              label: "Embedding",
            },
          },
        },
        {
          kind: "plugin",
          id: "lossless-claw",
          path: "plugins.entries.lossless-claw.config",
          source: "cli",
          confidence: "explicit",
          originPluginId: "lossless-claw",
          label: "Lossless Context Management",
          schema: {
            type: "object",
            properties: {
              dbPath: {
                type: "string",
              },
            },
          },
        },
      ],
      channelSurfaces: [
        {
          kind: "channel",
          id: "telegram",
          path: "channels.telegram",
          source: "bundled-sdk",
          confidence: "derived",
          originPluginId: "telegram",
          label: "Telegram",
          description: "Telegram channel",
          schema: {
            type: "object",
            properties: {
              token: {
                type: "string",
              },
            },
          },
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
          label: "Copilot Proxy",
          assistivePaths: [
            "models.providers.copilot-proxy",
            "models.providers.copilot-proxy.baseUrl",
          ],
        },
        {
          kind: "provider",
          id: "copilot-proxy-derived",
          path: "models.providers.copilot-proxy-derived",
          source: "code-ast",
          confidence: "derived",
          originPluginId: "copilot-proxy-derived",
          label: "Copilot Proxy Derived",
          schema: {
            type: "object",
            additionalProperties: true,
            properties: {
              baseUrl: {},
              models: {
                type: "array",
              },
            },
          },
        },
      ],
      status: {
        source: "cli",
        commandPath: "openclaw",
        pluginCount: 2,
        channelCount: 1,
        providerCount: 2,
        schemaBackedSurfaceCount: 4,
        assistiveOnlySurfaceCount: 1,
        confidence: {
          explicit: 2,
          derived: 2,
          inferred: 1,
        },
        authoritative: true,
        warnings: [],
      },
    });

    const schema = JSON.parse(overlay.schemaText) as Record<string, any>;
    const uiHints = JSON.parse(overlay.uiHintsText) as Record<string, any>;

    assert.deepEqual(schema.properties.plugins.properties.allow.items.enum, [
      "lossless-claw",
      "memu-engine",
    ]);
    assert.deepEqual(schema.properties.plugins.properties.slots.properties.memory.enum, [
      "none",
      "memu-engine",
    ]);
    assert.deepEqual(schema.properties.plugins.properties.slots.properties.contextEngine.enum, [
      "legacy",
      "lossless-claw",
    ]);
    assert.equal(
      schema.properties.plugins.properties.entries.properties["memu-engine"].properties.config.properties.embedding.type,
      "object",
    );
    assert.equal(uiHints["plugins.entries.memu-engine"].label, "memU Agentic Engine");
    assert.equal(
      uiHints["plugins.entries.memu-engine.config.embedding"].label,
      "Embedding",
    );
    assert.equal(schema.properties.channels.properties.telegram.properties.token.type, "string");
    assert.equal(
      schema.properties.models.properties.providers.properties["copilot-proxy"],
      undefined,
    );
    assert.equal(
      schema.properties.models.properties.providers.properties["copilot-proxy-derived"].properties.baseUrl.type,
      "string",
    );
    assert.equal(uiHints["channels.telegram"].label, "Telegram");
    assert.equal(uiHints["models.providers.copilot-proxy"].label, "Copilot Proxy");
    assert.equal(
      uiHints["models.providers.copilot-proxy.baseUrl"].__openclawAssistiveField,
      true,
    );
  });

  it("synthesizes plugins.slots.contextEngine when older base schemas omit it", () => {
    const baseSchema = JSON.stringify({
      type: "object",
      properties: {
        plugins: {
          type: "object",
          properties: {
            allow: {
              type: "array",
              items: { type: "string" },
            },
            deny: {
              type: "array",
              items: { type: "string" },
            },
            slots: {
              type: "object",
              properties: {
                memory: { type: "string" },
              },
            },
          },
        },
      },
    });

    const overlay = applyPluginOverlays(baseSchema, "{}", {
      plugins: [
        {
          id: "lossless-claw",
          kind: "context-engine",
        },
      ],
      pluginSurfaces: [],
      channelSurfaces: [],
      providerSurfaces: [],
      status: {
        source: "cli",
        commandPath: "openclaw",
        pluginCount: 1,
        channelCount: 0,
        providerCount: 0,
        schemaBackedSurfaceCount: 0,
        assistiveOnlySurfaceCount: 0,
        confidence: {
          explicit: 0,
          derived: 0,
          inferred: 0,
        },
        authoritative: true,
        warnings: [],
      },
    });

    const schema = JSON.parse(overlay.schemaText) as Record<string, any>;
    assert.deepEqual(schema.properties.plugins.properties.slots.properties.contextEngine.enum, [
      "legacy",
      "lossless-claw",
    ]);
  });
});
