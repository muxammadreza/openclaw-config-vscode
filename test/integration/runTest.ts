import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { runTests } from "@vscode/test-electron";

import { pathToFileURL } from "node:url";

const INHERITED_RUNNER_ENV_PREFIXES = ["ELECTRON_", "VSCODE_"] as const;

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, "../../");
  const extensionTestsPath = path.resolve(__dirname, "./suite/index.js");
  const previousEnv = captureEnvSnapshot(INHERITED_RUNNER_ENV_PREFIXES);
  const workspacePath = extensionDevelopmentPath;
  const localSchemaRoot = await createLocalSchemaFixture(extensionDevelopmentPath);

  try {
    sanitizeInheritedRunnerEnv(INHERITED_RUNNER_ENV_PREFIXES);

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [workspacePath],
      extensionTestsEnv: {
        OPENCLAW_MANIFEST_URL: pathToFileURL(path.join(localSchemaRoot, "live/manifest.json")).href,
      },
    });
  } finally {
    restoreEnvSnapshot(previousEnv);
    await fs.rm(localSchemaRoot, { recursive: true, force: true });
  }
}

async function createLocalSchemaFixture(extensionDevelopmentPath: string): Promise<string> {
  const sourceRoot = path.join(extensionDevelopmentPath, "schemas");
  const targetRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-vscode-schemas-"));
  await fs.cp(sourceRoot, targetRoot, { recursive: true });

  const manifestPaths = await collectManifestPaths(targetRoot);
  await Promise.all(
    manifestPaths.map(async (manifestPath) => {
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
        artifacts?: Record<string, { url?: string }>;
      };
      const manifestDir = path.dirname(manifestPath);
      if (manifest.artifacts?.schema) {
        manifest.artifacts.schema.url = pathToFileURL(
          path.join(manifestDir, "openclaw.schema.json"),
        ).href;
      }
      if (manifest.artifacts?.uiHints) {
        manifest.artifacts.uiHints.url = pathToFileURL(
          path.join(manifestDir, "openclaw.ui-hints.json"),
        ).href;
      }
      if (manifest.artifacts?.validator) {
        manifest.artifacts.validator.url = pathToFileURL(
          path.join(manifestDir, "openclaw.validator.mjs"),
        ).href;
      }
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    }),
  );

  return targetRoot;
}

async function collectManifestPaths(root: string): Promise<string[]> {
  const results: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectManifestPaths(absolutePath)));
      continue;
    }
    if (entry.isFile() && entry.name === "manifest.json") {
      results.push(absolutePath);
    }
  }
  return results;
}

function captureEnvSnapshot(prefixes: readonly string[]): Map<string, string> {
  const snapshot = new Map<string, string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (value && prefixes.some((prefix) => key.startsWith(prefix))) {
      snapshot.set(key, value);
    }
  }
  return snapshot;
}

function sanitizeInheritedRunnerEnv(prefixes: readonly string[]): void {
  for (const key of Object.keys(process.env)) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) {
      delete process.env[key];
    }
  }
}

function restoreEnvSnapshot(snapshot: Map<string, string>): void {
  sanitizeInheritedRunnerEnv(INHERITED_RUNNER_ENV_PREFIXES);
  for (const [key, value] of snapshot.entries()) {
    process.env[key] = value;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
