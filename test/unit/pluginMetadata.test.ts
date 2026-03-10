import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import {
  isPluginHintDocumentV1,
  loadPluginHintEntries,
} from "../../src/schema/pluginMetadata";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
});

describe("plugin metadata loader", () => {
  it("validates plugin metadata document shape", () => {
    assert.equal(isPluginHintDocumentV1({}), false);
    assert.equal(
      isPluginHintDocumentV1({
        version: 1,
        entries: [
          {
            path: "channels.whatsapp.accounts.*",
            properties: {
              configWrites: { description: "flag" },
            },
          },
        ],
      }),
      true,
    );
    assert.equal(
      isPluginHintDocumentV1({
        version: 1,
        entries: [
          {
            path: "channels.whatsapp.accounts.*",
            properties: {
              dynamicMode: {
                enumValues: ["strict", "relaxed"],
                examples: ["strict"],
                defaultValue: "strict",
              },
            },
          },
        ],
      }),
      true,
    );
    assert.equal(
      isPluginHintDocumentV1({
        version: 1,
        entries: [
          {
            path: "channels.whatsapp.accounts.*",
            properties: {
              dynamicMode: {
                enumValues: [{ invalid: true }],
              },
            },
          },
        ],
      }),
      false,
    );
  });

  it("loads and merges remote + local plugin metadata layers", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-hints-"));
    tempRoots.push(workspaceRoot);

    const localPath = ".openclaw/plugin-hints.json";
    await fs.mkdir(path.join(workspaceRoot, ".openclaw"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, localPath),
      JSON.stringify(
        {
          version: 1,
          entries: [
            {
              path: "channels.whatsapp.accounts.*",
              properties: {
                configWrites: {
                  description: "local override",
                  enumValues: [" strict ", "relaxed"],
                  examples: [" debug "],
                  defaultValue: " strict ",
                },
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await loadPluginHintEntries({
      workspaceRoot,
      localPath,
      remoteUrl: "https://raw.githubusercontent.com/muxammadreza/openclaw-config-vscode/main/plugin-hints.json",
      securityPolicy: {
        requireHttps: true,
        allowedHosts: ["raw.githubusercontent.com"],
        allowedRepositories: ["*"],
      },
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            version: 1,
            entries: [
              {
                path: "channels.whatsapp.accounts.*",
                properties: {
                  configWrites: { description: "remote value" },
                  remoteOnly: { description: "from remote" },
                },
              },
            ],
          }),
          { status: 200 },
        ),
    });

    assert.equal(result.warnings.length, 0);
    const entry = result.entries.find((item) => item.path === "channels.whatsapp.accounts.*");
    assert.ok(entry);
    assert.equal(entry.properties.configWrites.description, "local override");
    assert.deepEqual(entry.properties.configWrites.enumValues, ["strict", "relaxed"]);
    assert.deepEqual(entry.properties.configWrites.examples, ["debug"]);
    assert.equal(entry.properties.configWrites.defaultValue, "strict");
    assert.equal(entry.properties.remoteOnly.description, "from remote");
  });

  it("warns and skips remote metadata when blocked by security policy", async () => {
    const result = await loadPluginHintEntries({
      remoteUrl: "https://example.com/plugin-hints.json",
      securityPolicy: {
        requireHttps: true,
        allowedHosts: ["raw.githubusercontent.com"],
        allowedRepositories: ["muxammadreza/openclaw-config-vscode"],
      },
      fetchFn: async () => new Response("{}", { status: 200 }),
    });

    assert.equal(result.entries.length, 0);
    assert.equal(result.warnings.length > 0, true);
    assert.match(result.warnings[0], /blocked/i);
  });
});
