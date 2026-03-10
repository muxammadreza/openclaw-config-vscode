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
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-vscode-test-workspace-"));

  try {
    sanitizeInheritedRunnerEnv(INHERITED_RUNNER_ENV_PREFIXES);

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [workspacePath],
      extensionTestsEnv: {
        OPENCLAW_MANIFEST_URL: pathToFileURL(path.join(extensionDevelopmentPath, "schemas/live/manifest.json")).href,
      },
    });
  } finally {
    restoreEnvSnapshot(previousEnv);
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
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
