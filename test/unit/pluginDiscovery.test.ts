import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
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
      "channels": ["telegram"],
      "providers": ["copilot-proxy"],
      "skills": ["remember"],
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
    assert.deepEqual(plugins[0].declaredChannels, ["telegram"]);
    assert.deepEqual(plugins[0].declaredProviders, ["copilot-proxy"]);
    assert.deepEqual(plugins[0].declaredSkills, ["remember"]);
    assert.deepEqual(plugins[0].configUiHints, {
      dbPath: {
        label: "Database Path",
      },
    });
  });
});
