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
  await Promise.all(
    tempRoots.splice(0).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
});

describe("artifactManager", () => {
  it("falls back to bundled artifacts when sync fails", async () => {
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
    assert.equal(await manager.getActiveSource(), "bundled");
    assert.match(await manager.getSchemaText(), /OpenClawConfig/);
  });

  it("downloads and activates cache artifacts when manifest hashes match", async () => {
    const fixture = await createFixture();

    const remoteSchema = JSON.stringify({ type: "object", properties: { gateway: { type: "object" } } });
    const remoteHints = JSON.stringify({ gateway: { label: "Gateway" } });
    const remoteValidator = "export function validate(raw){return raw && raw.bad ? [{path:'bad',message:'bad value'}] : []}";

    const manifest = {
      version: 1,
      openclawCommit: "abc123",
      generatedAt: new Date().toISOString(),
      artifacts: {
        schema: {
          url: "https://example.com/openclaw.schema.json",
          sha256: sha256Hex(remoteSchema),
        },
        uiHints: {
          url: "https://example.com/openclaw.ui-hints.json",
          sha256: sha256Hex(remoteHints),
        },
        validator: {
          url: "https://example.com/openclaw.validator.mjs",
          sha256: sha256Hex(remoteValidator),
        },
      },
    };

    const manager = new SchemaArtifactManager({
      context: fixture.context,
      manifestUrl: "https://example.com/manifest.json",
      fetchFn: async (url: string | URL | Request) => {
        const key = String(url);
        if (key.endsWith("manifest.json")) {
          return new Response(JSON.stringify(manifest), { status: 200 });
        }
        if (key.endsWith("openclaw.schema.json")) {
          return new Response(remoteSchema, { status: 200 });
        }
        if (key.endsWith("openclaw.ui-hints.json")) {
          return new Response(remoteHints, { status: 200 });
        }
        if (key.endsWith("openclaw.validator.mjs")) {
          return new Response(remoteValidator, { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
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

  it("loads validator only from bundled artifacts even when cache is active", async () => {
    const bundledValidator =
      "export function validate(raw){return raw && raw.fromCache ? [{path:'bundled',message:'bundled'}] : []}";
    const fixture = await createFixture({ bundledValidator });

    const remoteSchema = JSON.stringify({ type: "object", properties: { gateway: { type: "object" } } });
    const remoteHints = JSON.stringify({ gateway: { label: "Gateway" } });
    const remoteValidator =
      "export function validate(raw){return raw && raw.fromCache ? [{path:'cache',message:'cache'}] : []}";

    const manifest = {
      version: 1,
      openclawCommit: "validator-check",
      generatedAt: new Date().toISOString(),
      artifacts: {
        schema: {
          url: "https://example.com/openclaw.schema.json",
          sha256: sha256Hex(remoteSchema),
        },
        uiHints: {
          url: "https://example.com/openclaw.ui-hints.json",
          sha256: sha256Hex(remoteHints),
        },
        validator: {
          url: "https://example.com/openclaw.validator.mjs",
          sha256: sha256Hex(remoteValidator),
        },
      },
    };

    const manager = new SchemaArtifactManager({
      context: fixture.context,
      manifestUrl: "https://example.com/manifest.json",
      importModuleFn: async (moduleUrl: string) => {
        if (moduleUrl.includes("/schemas/live/")) {
          return {
            validate: (raw: unknown) =>
              raw && typeof raw === "object" && "fromCache" in raw
                ? [{ path: "bundled", message: "bundled" }]
                : [],
          };
        }
        return {
          validate: () => [{ path: "cache", message: "cache" }],
        };
      },
      fetchFn: async (url: string | URL | Request) => {
        const key = String(url);
        if (key.endsWith("manifest.json")) {
          return new Response(JSON.stringify(manifest), { status: 200 });
        }
        if (key.endsWith("openclaw.schema.json")) {
          return new Response(remoteSchema, { status: 200 });
        }
        if (key.endsWith("openclaw.ui-hints.json")) {
          return new Response(remoteHints, { status: 200 });
        }
        if (key.endsWith("openclaw.validator.mjs")) {
          return new Response(remoteValidator, { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
      securityPolicy: {
        allowedHosts: ["example.com"],
        allowedRepositories: ["*"],
      },
    });

    const result = await manager.initialize(6);
    assert.equal(result.updated, true);
    assert.equal(await manager.getActiveSource(), "cache");

    const validator = await manager.getValidator();
    assert.ok(validator);
    const issues = validator.validate({ fromCache: true });
    assert.equal(issues[0]?.path, "bundled");
  });

  it("rejects invalid artifact hashes and keeps bundled fallback", async () => {
    const fixture = await createFixture();

    const remoteSchema = JSON.stringify({ type: "object" });
    const remoteHints = JSON.stringify({});
    const remoteValidator = "export function validate(){return []}";

    const manifest = {
      version: 1,
      openclawCommit: "broken-hash",
      generatedAt: new Date().toISOString(),
      artifacts: {
        schema: {
          url: "https://example.com/openclaw.schema.json",
          sha256: "0".repeat(64),
        },
        uiHints: {
          url: "https://example.com/openclaw.ui-hints.json",
          sha256: sha256Hex(remoteHints),
        },
        validator: {
          url: "https://example.com/openclaw.validator.mjs",
          sha256: sha256Hex(remoteValidator),
        },
      },
    };

    const manager = new SchemaArtifactManager({
      context: fixture.context,
      manifestUrl: "https://example.com/manifest.json",
      fetchFn: async (url: string | URL | Request) => {
        const key = String(url);
        if (key.endsWith("manifest.json")) {
          return new Response(JSON.stringify(manifest), { status: 200 });
        }
        if (key.endsWith("openclaw.schema.json")) {
          return new Response(remoteSchema, { status: 200 });
        }
        if (key.endsWith("openclaw.ui-hints.json")) {
          return new Response(remoteHints, { status: 200 });
        }
        if (key.endsWith("openclaw.validator.mjs")) {
          return new Response(remoteValidator, { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
      securityPolicy: {
        allowedHosts: ["example.com"],
        allowedRepositories: ["*"],
      },
    });

    const result = await manager.initialize(6);
    assert.equal(result.updated, false);
    assert.equal(await manager.getActiveSource(), "bundled");
    assert.match(result.message, /SHA-256 mismatch/);
  });

  it("blocks non-allowlisted hosts and keeps fallback source", async () => {
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
    assert.equal(await manager.getActiveSource(), "bundled");
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

    assert.equal(status.source, "bundled");
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
        validator: {
          url: "https://raw.githubusercontent.com/muxammadreza/openclaw-config-vscode/main/openclaw.validator.mjs",
          sha256: "c".repeat(64),
        },
      },
    };

    const manager = new SchemaArtifactManager({
      context: fixture.context,
      manifestUrl:
        "https://raw.githubusercontent.com/muxammadreza/openclaw-config-vscode/main/schemas/live/manifest.json",
      fetchFn: async (url: string | URL | Request) => {
        const key = String(url);
        if (key.endsWith("manifest.json")) {
          return new Response(JSON.stringify(manifest), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const result = await manager.initialize(6);
    assert.equal(result.updated, false);
    assert.equal(await manager.getActiveSource(), "bundled");
    assert.match(result.message, /artifact policy/i);
  });

  it("validates schema manifest contract", () => {
    assert.equal(isSchemaManifestV1({}), false);
    assert.equal(
      isSchemaManifestV1({
        version: 1,
        openclawCommit: "abc",
        generatedAt: new Date().toISOString(),
        artifacts: {
          schema: { url: "https://x", sha256: "a".repeat(64) },
          uiHints: { url: "https://x", sha256: "b".repeat(64) },
          validator: { url: "https://x", sha256: "c".repeat(64) },
        },
      }),
      true,
    );
  });
});

async function createFixture(options?: {
  bundledValidator?: string;
}): Promise<{
  root: string;
  context: {
    extensionPath: string;
    globalStorageUri: { fsPath: string };
  };
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ext-test-"));
  tempRoots.push(root);

  const bundledDir = path.join(root, "schemas", "live");
  const globalStorage = path.join(root, ".global");
  await fs.mkdir(bundledDir, { recursive: true });
  await fs.mkdir(globalStorage, { recursive: true });

  const schema = JSON.stringify({ title: "OpenClawConfig" }, null, 2);
  const hints = JSON.stringify({}, null, 2);
  const validator = options?.bundledValidator ?? "export function validate(){return []}";

  await fs.writeFile(path.join(bundledDir, "openclaw.schema.json"), schema, "utf8");
  await fs.writeFile(path.join(bundledDir, "openclaw.ui-hints.json"), hints, "utf8");
  await fs.writeFile(path.join(bundledDir, "openclaw.validator.mjs"), validator, "utf8");
  await fs.writeFile(
    path.join(bundledDir, "manifest.json"),
    JSON.stringify(
      {
        version: 1,
        openclawCommit: "bundled",
        generatedAt: new Date().toISOString(),
        artifacts: {
          schema: {
            url: "https://example.com/openclaw.schema.json",
            sha256: sha256Hex(schema),
          },
          uiHints: {
            url: "https://example.com/openclaw.ui-hints.json",
            sha256: sha256Hex(hints),
          },
          validator: {
            url: "https://example.com/openclaw.validator.mjs",
            sha256: sha256Hex(validator),
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    root,
    context: {
      extensionPath: root,
      globalStorageUri: { fsPath: globalStorage },
    },
  };
}
