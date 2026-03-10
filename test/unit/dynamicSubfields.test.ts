import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  buildDynamicSubfieldCatalog,
  resolveDynamicSubfields,
  resolveDynamicSubfieldsWithMatches,
} from "../../src/schema/dynamicSubfields";

describe("dynamicSubfields catalog", () => {
  it("resolves wildcard object paths from schema", () => {
    const schema = JSON.stringify({
      type: "object",
      properties: {
        channels: {
          type: "object",
          properties: {
            whatsapp: {
              type: "object",
              properties: {
                accounts: {
                  type: "object",
                  additionalProperties: {
                    type: "object",
                    properties: {
                      enabled: { type: "boolean" },
                      sendReadReceipts: { type: "boolean" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    const hints = JSON.stringify({
      "channels.whatsapp.accounts.*.sendReadReceipts": {
        help: "Enable or disable read receipts.",
      },
    });

    const catalog = buildDynamicSubfieldCatalog(schema, hints, []);
    const entries = resolveDynamicSubfields(catalog, "channels.whatsapp.accounts.default");
    const keys = entries.map((entry) => entry.key);

    assert.equal(keys.includes("enabled"), true);
    assert.equal(keys.includes("sendReadReceipts"), true);
  });

  it("merges plugin metadata and prefers plugin entries over schema entries", () => {
    const schema = JSON.stringify({
      type: "object",
      properties: {
        channels: {
          type: "object",
          properties: {
            whatsapp: {
              type: "object",
              properties: {
                accounts: {
                  type: "object",
                  additionalProperties: {
                    type: "object",
                    properties: {
                      configWrites: { type: "boolean", description: "schema description" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    const hints = JSON.stringify({});

    const catalog = buildDynamicSubfieldCatalog(schema, hints, [
      {
        path: "channels.whatsapp.accounts.*",
        properties: {
          configWrites: {
            description: "plugin override",
          },
          customPluginFlag: {
            description: "plugin flag",
          },
        },
      },
    ]);

    const entries = resolveDynamicSubfields(catalog, "channels.whatsapp.accounts.business");
    const configWrites = entries.find((entry) => entry.key === "configWrites");
    const pluginFlag = entries.find((entry) => entry.key === "customPluginFlag");

    assert.ok(configWrites);
    assert.equal(configWrites.source, "plugin");
    assert.equal(configWrites.description, "plugin override");
    assert.ok(pluginFlag);
  });

  it("derives value hints from enum/const/default/examples including composed schemas", () => {
    const schema = JSON.stringify({
      type: "object",
      properties: {
        gateway: {
          type: "object",
          properties: {
            mode: {
              oneOf: [{ const: "token" }, { const: "oauth" }],
            },
            retries: {
              type: "integer",
              default: 3,
              examples: [1, 5],
            },
          },
        },
      },
    });

    const catalog = buildDynamicSubfieldCatalog(schema, "{}", []);
    const entries = resolveDynamicSubfields(catalog, "gateway");
    const mode = entries.find((entry) => entry.key === "mode");
    const retries = entries.find((entry) => entry.key === "retries");

    assert.ok(mode);
    assert.deepEqual(mode.valueHints?.enumValues, ["token", "oauth"]);
    assert.equal(mode.valueHints?.valueType, "string");

    assert.ok(retries);
    assert.equal(retries.valueHints?.valueType, "integer");
    assert.equal(retries.valueHints?.defaultValue, 3);
    assert.deepEqual(retries.valueHints?.examples, [1, 5]);
  });

  it("preserves schema value hints when plugin only overrides selected fields", () => {
    const schema = JSON.stringify({
      type: "object",
      properties: {
        channels: {
          type: "object",
          properties: {
            whatsapp: {
              type: "object",
              properties: {
                accounts: {
                  type: "object",
                  additionalProperties: {
                    type: "object",
                    properties: {
                      dynamicMode: {
                        type: "string",
                        enum: ["strict", "relaxed"],
                        default: "strict",
                        description: "schema description",
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const catalog = buildDynamicSubfieldCatalog(schema, "{}", [
      {
        path: "channels.whatsapp.accounts.*",
        properties: {
          dynamicMode: {
            description: "plugin description",
          },
        },
      },
    ]);

    const entries = resolveDynamicSubfields(catalog, "channels.whatsapp.accounts.primary");
    const dynamicMode = entries.find((entry) => entry.key === "dynamicMode");

    assert.ok(dynamicMode);
    assert.equal(dynamicMode.source, "plugin");
    assert.equal(dynamicMode.description, "plugin description");
    assert.deepEqual(dynamicMode.valueHints?.enumValues, ["strict", "relaxed"]);
    assert.equal(dynamicMode.valueHints?.defaultValue, "strict");
  });

  it("exposes wildcard match metadata for hybrid filtering", () => {
    const schema = JSON.stringify({
      type: "object",
      properties: {
        channels: {
          type: "object",
          properties: {
            whatsapp: {
              type: "object",
              properties: {
                accounts: {
                  type: "object",
                  additionalProperties: {
                    type: "object",
                    properties: {
                      enabled: { type: "boolean" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const catalog = buildDynamicSubfieldCatalog(schema, "{}", []);
    const entries = resolveDynamicSubfieldsWithMatches(
      catalog,
      "channels.whatsapp.accounts.default",
    );
    const enabled = entries.find((entry) => entry.entry.key === "enabled");

    assert.ok(enabled);
    assert.equal(enabled.matchedByWildcard, true);
    assert.equal(enabled.matchedPattern, "channels.whatsapp.accounts.*");
  });

  it("builds completion entries from assistive discovery hints without schema fields", () => {
    const catalog = buildDynamicSubfieldCatalog(
      JSON.stringify({
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
                    baseUrl: { type: "string" },
                  },
                },
              },
            },
          },
        },
      }),
      JSON.stringify({
        "models.providers.copilot-proxy": {
          __openclawAssistiveField: true,
        },
        "models.providers.copilot-proxy.authHeader": {
          __openclawAssistiveField: true,
        },
      }),
      [],
    );

    const providerEntries = resolveDynamicSubfields(catalog, "models.providers");
    const configEntries = resolveDynamicSubfields(catalog, "models.providers.copilot-proxy");

    assert.equal(providerEntries.some((entry) => entry.key === "copilot-proxy"), true);
    assert.equal(configEntries.some((entry) => entry.key === "authHeader"), true);
  });
});
