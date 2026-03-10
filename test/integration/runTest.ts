import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, "../../");
  const extensionTestsPath = path.resolve(__dirname, "./suite/index.js");
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-vscode-test-workspace-"));

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [workspacePath, "--disable-extensions"],
      extensionTestsEnv: {
        OPENCLAW_MANIFEST_URL: "http://127.0.0.1:9/manifest.json",
      },
    });
  } finally {
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
