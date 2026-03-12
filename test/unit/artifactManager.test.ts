import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import {
  SchemaArtifactManager,
  isSchemaManifestV1,
  sha256Hex,
} from "../../src/schema/artifactManager";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("artifactManager", () => {
  it("reports a missing source when remote sync fails and no cache exists", async () => {
    const fixture = await createFixture();

    const manager = new SchemaArtifactManager({
      context: fixture.context,
      manifestUrl: "https://example.com/manifest.json",
      fetchFn: async () => {
        throw new Error("offline");
      },
      securityPolicy: {
        allowedHosts: ["example.com"],
        allowedRepositories: ["*"],
      },
    });

    const result = await manager.initialize(6);
    assert.equal(result.updated, false);
    assert.equal(result.source, "missing");

    const status = await manager.getStatus();
    assert.equal(status.source, "missing");
    await assert.rejects(() => manager.getSchemaText(), /No remote schema cache is available/);
  });

  it("downloads and activates remote cache artifacts when manifest hashes match", async () => {
    const fixture = await createFixture();
    const remoteSchema = JSON.stringify({ type: "object", properties: { gateway: { type: "object" } } });
    const remoteHints = JSON.stringify({ gateway: { label: "Gateway" } });
    const manifest = buildManifest({
      schema: remoteSchema,
      uiHints: remoteHints,
    });

    const manager = new SchemaArtifactManager({
      context: fixture.context,
      manifestUrl: "https://example.com/manifest.json",
      fetchFn: buildFetch({
        manifest,
        schema: remoteSchema,
        uiHints: remoteHints,
      }),
      securityPolicy: {
        allowedHosts: ["example.com"],
        allowedRepositories: ["*"],
      },
    });

    const result = await manager.initialize(6);
    assert.equal(result.updated, true);
    assert.equal(await manager.getActiveSource(), "cache");
    assert.equal(await manager.getSchemaText(), remoteSchema);
    assert.equal(await manager.getUiHintsText(), remoteHints);
  });

  it("clears stale cache content before rebuilding", async () => {
    const fixture = await createFixture();
    const remoteSchema = JSON.stringify({ type: "object" });
    const remoteHints = JSON.stringify({});
    const manifest = buildManifest({
      schema: remoteSchema,
      uiHints: remoteHints,
    });

    const manager = new SchemaArtifactManager({
      context: fixture.context,
      manifestUrl: "https://example.com/manifest.json",
      fetchFn: buildFetch({
        manifest,
        schema: remoteSchema,
        uiHints: remoteHints,
      }),
      securityPolicy: {
        allowedHosts: ["example.com"],
        allowedRepositories: ["*"],
      },
    });

    await manager.initialize(6);
    const staleFile = path.join(fixture.context.globalStorageUri.fsPath, "schema-cache", "stale.txt");
    await fs.writeFile(staleFile, "stale", "utf8");
    assert.equal(await pathExists(staleFile), true);

    await manager.clearCache();

    assert.equal(await pathExists(staleFile), false);
    await assert.rejects(() => manager.getSchemaText(), /No remote schema cache is available/);
  });

  it("rejects invalid artifact hashes and keeps the source missing", async () => {
    const fixture = await createFixture();
    const remoteSchema = JSON.stringify({ type: "object" });
    const remoteHints = JSON.stringify({});
    const manifest = {
      ...buildManifest({
        schema: remoteSchema,
        uiHints: remoteHints,
      }),
      artifacts: {
        schema: {
          url: "https://example.com/openclaw.schema.json",
          sha256: "0".repeat(64),
        },
        uiHints: {
          url: "https://example.com/openclaw.ui-hints.json",
          sha256: sha256Hex(remoteHints),
        },
      },
    };

    const manager = new SchemaArtifactManager({
      context: fixture.context,
      manifestUrl: "https://example.com/manifest.json",
      fetchFn: buildFetch({
        manifest,
        schema: remoteSchema,
        uiHints: remoteHints,
      }),
      securityPolicy: {
        allowedHosts: ["example.com"],
        allowedRepositories: ["*"],
      },
    });

    const result = await manager.initialize(6);
    assert.equal(result.updated, false);
    assert.equal(result.source, "missing");
    assert.match(result.message, /SHA-256 mismatch/);
  });

  it("blocks non-allowlisted hosts", async () => {
    const fixture = await createFixture();

    const manager = new SchemaArtifactManager({
      context: fixture.context,
      manifestUrl: "https://evil.example.com/manifest.json",
      fetchFn: async () => new Response("{}", { status: 200 }),
      securityPolicy: {
        allowedHosts: ["raw.githubusercontent.com"],
        allowedRepositories: ["muxammadreza/openclaw-config-vscode"],
      },
    });

    const result = await manager.initialize(6);
    assert.equal(result.updated, false);
    assert.equal(result.source, "missing");
    assert.match(result.message, /security policy/i);
  });

  it("returns schema status with policy evaluation metadata", async () => {
    const fixture = await createFixture();

    const manager = new SchemaArtifactManager({
      context: fixture.context,
      manifestUrl:
        "https://raw.githubusercontent.com/muxammadreza/openclaw-config-vscode/main/schemas/live/manifest.json",
      fetchFn: async () => {
        throw new Error("offline");
      },
    });

    await manager.initialize(6);
    const status = await manager.getStatus();

    assert.equal(status.source, "missing");
    assert.equal(status.policy.manifest.allowed, true);
    assert.equal(Array.isArray(status.policy.artifacts), true);
  });

  it("blocks artifact URLs that point to non-allowlisted repositories", async () => {
    const fixture = await createFixture();
    const manifest = {
      version: 1,
      openclawCommit: "abc123",
      generatedAt: new Date().toISOString(),
      artifacts: {
        schema: {
          url: "https://raw.githubusercontent.com/attacker/repo/main/openclaw.schema.json",
          sha256: "a".repeat(64),
        },
        uiHints: {
          url: "https://raw.githubusercontent.com/muxammadreza/openclaw-config-vscode/main/openclaw.ui-hints.json",
          sha256: "b".repeat(64),
        },
      },
    };

    const manager = new SchemaArtifactManager({
      context: fixture.context,
      manifestUrl:
        "https://raw.githubusercontent.com/muxammadreza/openclaw-config-vscode/main/schemas/live/manifest.json",
      fetchFn: async (url) => {
        const key = String(url);
        if (key.endsWith("manifest.json")) {
          return new Response(JSON.stringify(manifest), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const result = await manager.initialize(6);
    assert.equal(result.updated, false);
    assert.equal(result.source, "missing");
    assert.match(result.message, /artifact policy/i);
  });

  it("validates the schema manifest contract", () => {
    assert.equal(isSchemaManifestV1({}), false);
    assert.equal(
      isSchemaManifestV1(
        buildManifest({
          schema: JSON.stringify({ type: "object" }),
          uiHints: JSON.stringify({}),
        }),
      ),
      true,
    );
  });
});

async function createFixture(): Promise<{
  context: {
    globalStorageUri: { fsPath: string };
  };
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ext-test-"));
  tempRoots.push(root);
  const globalStorage = path.join(root, ".global");
  await fs.mkdir(globalStorage, { recursive: true });

  return {
    context: {
      globalStorageUri: { fsPath: globalStorage },
    },
  };
}

function buildManifest(options: {
  schema: string;
  uiHints: string;
}) {
  return {
    version: 1,
    openclawCommit: "abc123",
    generatedAt: new Date().toISOString(),
    artifacts: {
      schema: {
        url: "https://example.com/openclaw.schema.json",
        sha256: sha256Hex(options.schema),
      },
      uiHints: {
        url: "https://example.com/openclaw.ui-hints.json",
        sha256: sha256Hex(options.uiHints),
      },
    },
  };
}

function buildFetch(options: {
  manifest: ReturnType<typeof buildManifest> | Record<string, unknown>;
  schema: string;
  uiHints: string;
}) {
  return async (url: string | URL | Request) => {
    const key = String(url);
    if (key.endsWith("manifest.json")) {
      return new Response(JSON.stringify(options.manifest), { status: 200 });
    }
    if (key.endsWith("openclaw.schema.json")) {
      return new Response(options.schema, { status: 200 });
    }
    if (key.endsWith("openclaw.ui-hints.json")) {
      return new Response(options.uiHints, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
