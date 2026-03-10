import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { evaluatePluginValidationIssues } from "../../src/validation/pluginRules";

describe("plugin validation rules", () => {
  it("flags missing allowlist and slot plugin ids", () => {
    const issues = evaluatePluginValidationIssues(
      {
        plugins: {
          allow: ["memu-engine", "ghost-plugin"],
          slots: {
            memory: "ghost-plugin",
            contextEngine: "legacy",
          },
        },
      },
      [
        {
          id: "memu-engine",
          kind: "memory",
          enabled: true,
        },
      ],
    );

    assert.equal(issues.some((issue) => issue.code === "plugin-allow-missing"), true);
    assert.equal(issues.some((issue) => issue.code === "plugin-slot-memory-missing"), true);
    assert.equal(
      issues.some((issue) => issue.code === "plugin-slot-context-engine-missing"),
      false,
    );
  });

  it("warns for stale plugin entries and disabled plugin config", () => {
    const issues = evaluatePluginValidationIssues(
      {
        plugins: {
          entries: {
            "ghost-plugin": {
              enabled: true,
            },
            "memu-engine": {
              config: {
                embedding: {
                  provider: "openai",
                },
              },
            },
          },
        },
      },
      [
        {
          id: "memu-engine",
          enabled: false,
        },
      ],
    );

    assert.equal(issues.some((issue) => issue.code === "plugin-entry-missing"), true);
    assert.equal(issues.some((issue) => issue.code === "plugin-disabled-config"), true);
  });
});
