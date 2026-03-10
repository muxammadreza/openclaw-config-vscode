import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  buildBundledChannelSurfaceFromModule,
  buildBundledChannelSurfaceFromSourceText,
  extractAstSurfaceDataFromText,
  extractJsonPayload,
  parseCliPluginListRaw,
} from "../../src/schema/pluginDiscovery";

describe("plugin discovery", () => {
  it("extracts JSON after leading CLI log noise", () => {
    const parsed = extractJsonPayload(`\
[plugins] plugin loaded
{
  "plugins": [
    {
      "id": "memu-engine",
      "name": "memU Agentic Engine"
    }
  ]
}`);

    assert.deepEqual(parsed, {
      plugins: [
        {
          id: "memu-engine",
          name: "memU Agentic Engine",
        },
      ],
    });
  });

  it("normalizes discovered plugins from raw CLI payloads", () => {
    const plugins = parseCliPluginListRaw(`\
[plugins] warm-up
{
  "plugins": [
    {
      "id": "lossless-claw",
      "name": "Lossless Context Management",
      "kind": "context-engine",
      "enabled": true,
      "configJsonSchema": {
        "type": "object",
        "properties": {
          "dbPath": {
            "type": "string"
          }
        }
      },
      "configUiHints": {
        "dbPath": {
          "label": "Database Path"
        }
      }
    }
  ]
}`);

    assert.equal(plugins.length, 1);
    assert.equal(plugins[0].id, "lossless-claw");
    assert.equal(plugins[0].kind, "context-engine");
    assert.equal(plugins[0].enabled, true);
    assert.deepEqual(plugins[0].configUiHints, {
      dbPath: {
        label: "Database Path",
      },
    });
  });

  it("builds a bundled channel surface from public SDK exports", () => {
    const surface = buildBundledChannelSurfaceFromModule(
      {
        channelId: "telegram",
        originPluginId: "telegram",
        label: "Telegram",
        description: "Telegram channel",
      },
      {
        buildChannelConfigSchema: (schema: Record<string, unknown>) => ({
          schema: {
            type: "object",
            properties: {
              token: {
                type: "string",
              },
              ...((schema.properties as Record<string, unknown> | undefined) ?? {}),
            },
          },
        }),
        TelegramConfigSchema: {
          type: "object",
          properties: {
            polling: {
              type: "boolean",
            },
          },
        },
      },
    );

    assert.ok(surface);
    assert.equal(surface?.path, "channels.telegram");
    assert.equal((surface?.schema?.properties as Record<string, any>).polling.type, "boolean");
    assert.equal(surface?.confidence, "derived");
  });

  it("builds bundled channel surfaces from source when sdk exports are incomplete", () => {
    const surface = buildBundledChannelSurfaceFromSourceText(
      `import { z } from "zod";
      export const NextcloudTalkConfigSchema = z.object({
        baseUrl: z.string().optional(),
        rooms: z.record(z.string(), z.object({
          requireMention: z.boolean().optional(),
        }).optional()).optional(),
      }).strict();`,
      "config-schema.ts",
      {
        channelId: "nextcloud-talk",
        originPluginId: "nextcloud-talk",
        label: "Nextcloud Talk",
      },
    );

    assert.ok(surface);
    assert.equal((surface?.schema?.properties as Record<string, any>).baseUrl.type, "string");
    assert.equal(
      ((((surface?.schema?.properties as Record<string, any>).rooms.additionalProperties as Record<string, any>)
        .properties as Record<string, any>).requireMention.type),
      "boolean",
    );
  });

  it("extracts provider config surfaces and assistive paths from nested configPatch source text", () => {
    const record = extractAstSurfaceDataFromText(
      `const PROVIDER_ID = "copilot-proxy";
      api.registerProvider({
        id: PROVIDER_ID,
        label: "Copilot Proxy",
        auth: [{
          id: "local",
          run: async () => {
            return {
              configPatch: {
                models: {
                  providers: {
                    [PROVIDER_ID]: {
                      baseUrl: DEFAULT_BASE_URL,
                      authHeader: false,
                      models: modelIds.map((modelId) => buildModelDefinition(modelId)),
                    },
                  },
                },
              },
            };
          },
        }],
      });
      `,
      "index.ts",
      {
        id: "copilot-proxy",
        name: "Copilot Proxy",
        description: "Local provider plugin",
        declaredProviders: ["copilot-proxy"],
      },
    );

    assert.equal(record.providerSurfaceSeeds.length, 1);
    assert.equal(record.providerSurfaceSeeds[0].id, "copilot-proxy");
    assert.equal(record.providerSurfaceSeeds[0].confidence, "derived");
    assert.equal(record.providerPaths.has("copilot-proxy"), true);
    assert.equal(record.labels.get("models.providers.copilot-proxy"), "Copilot Proxy");
  });
});
