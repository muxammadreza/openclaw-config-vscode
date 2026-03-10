import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { applyPluginOverlays } from "../../src/schema/pluginOverlays";

describe("plugin overlays", () => {
  it("adds explicit plugin entry schemas, ui hints, and slot enums", () => {
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

    const overlay = applyPluginOverlays(baseSchema, baseUiHints, [
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
    ]);

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
  });
});
