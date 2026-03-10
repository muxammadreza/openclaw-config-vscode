import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { LocalRuntimeProfileService } from "../../src/runtime/localRuntimeProfile";

describe("local runtime profile", () => {
  it("parses version, config path, and validator capability from the CLI", async () => {
    const service = new LocalRuntimeProfileService({
      output: {
        appendLine: () => {},
      },
      execFileFn: async (_file, args) => {
        const command = args.join(" ");
        if (command === "--version") {
          return { stdout: "OpenClaw 2026.3.8 (3caab92)\n", stderr: "" };
        }
        if (command === "config file") {
          return { stdout: "~/.openclaw/openclaw.json\n", stderr: "" };
        }
        if (command === "config validate --help") {
          return { stdout: "Usage: openclaw config validate [--json]\n", stderr: "" };
        }
        throw new Error(`Unexpected command: ${command}`);
      },
    });

    const profile = await service.getProfile({
      commandPath: "openclaw",
    });

    assert.equal(profile.available, true);
    assert.equal(profile.version, "2026.3.8");
    assert.equal(profile.versionTag, "v2026.3.8");
    assert.equal(profile.configPath?.endsWith("/.openclaw/openclaw.json"), true);
    assert.equal(profile.validatorSupportsJson, true);
  });
});
