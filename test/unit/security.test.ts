import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  evaluateUrlSecurity,
  extractRepositoryFromUrl,
  normalizeList,
  normalizePolicyInput,
} from "../../src/schema/security";

describe("schema security policy", () => {
  it("normalizes policy values", () => {
    const normalized = normalizePolicyInput({
      requireHttps: true,
      allowedHosts: [" Raw.GitHubUserContent.Com ", "raw.githubusercontent.com", ""],
      allowedRepositories: [" Jorekai/OpenClaw-Config-Vscode ", "muxammadreza/openclaw-config-vscode"],
    });

    assert.deepEqual(normalized.allowedHosts, ["raw.githubusercontent.com"]);
    assert.deepEqual(normalized.allowedRepositories, ["muxammadreza/openclaw-config-vscode"]);
  });

  it("accepts https URL with allowlisted host and repository", () => {
    const evaluation = evaluateUrlSecurity(
      "https://raw.githubusercontent.com/muxammadreza/openclaw-config-vscode/main/schemas/live/manifest.json",
      {
        requireHttps: true,
        allowedHosts: ["raw.githubusercontent.com"],
        allowedRepositories: ["muxammadreza/openclaw-config-vscode"],
      },
    );

    assert.equal(evaluation.allowed, true);
    assert.equal(evaluation.repository, "muxammadreza/openclaw-config-vscode");
  });

  it("rejects non-https URL when https is required", () => {
    const evaluation = evaluateUrlSecurity("http://raw.githubusercontent.com/a/b/main/file.json", {
      requireHttps: true,
      allowedHosts: ["raw.githubusercontent.com"],
      allowedRepositories: ["a/b"],
    });

    assert.equal(evaluation.allowed, false);
    assert.match(evaluation.reason, /https/i);
  });

  it("rejects repository not on allowlist", () => {
    const evaluation = evaluateUrlSecurity(
      "https://raw.githubusercontent.com/attacker/repo/main/manifest.json",
      {
        requireHttps: true,
        allowedHosts: ["raw.githubusercontent.com"],
        allowedRepositories: ["muxammadreza/openclaw-config-vscode"],
      },
    );

    assert.equal(evaluation.allowed, false);
    assert.match(evaluation.reason, /repository is not allowlisted/i);
  });

  it("allows arbitrary repositories when wildcard is configured", () => {
    const evaluation = evaluateUrlSecurity(
      "https://raw.githubusercontent.com/attacker/repo/main/manifest.json",
      {
        requireHttps: true,
        allowedHosts: ["raw.githubusercontent.com"],
        allowedRepositories: ["*"],
      },
    );

    assert.equal(evaluation.allowed, true);
  });

  it("extracts repository from URL path", () => {
    const repository = extractRepositoryFromUrl(
      new URL("https://raw.githubusercontent.com/muxammadreza/openclaw-config-vscode/main/schemas/live/manifest.json"),
    );
    assert.equal(repository, "muxammadreza/openclaw-config-vscode");
    assert.deepEqual(normalizeList(["A", " a ", ""]), ["a"]);
  });
});
