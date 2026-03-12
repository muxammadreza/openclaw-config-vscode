import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";

vi.mock("vscode", () => ({}));

describe("codeActions path helpers", () => {
  it("extracts unknown keys from validator messages", async () => {
    const { extractUnknownKey } = await import("../../src/validation/codeActions/path");

    assert.equal(extractUnknownKey('Unrecognized key: "foo"'), "foo");
    assert.equal(extractUnknownKey('Property "bar" is not allowed'), "bar");
    assert.equal(extractUnknownKey("No unknown key here"), null);
  });

  it("extracts binding index", async () => {
    const { extractBindingIndex } = await import("../../src/validation/codeActions/path");

    assert.equal(extractBindingIndex("bindings.12.match.accountId"), 12);
    assert.equal(extractBindingIndex("gateway.apiKey"), null);
  });

  it("normalizes env var names from path", async () => {
    const { toEnvVarName } = await import("../../src/validation/codeActions/secrets");

    assert.equal(toEnvVarName("gateway.apiKey"), "OPENCLAW_GATEWAY_APIKEY");
    assert.equal(toEnvVarName("bindings.0.match.access-token"), "OPENCLAW_BINDINGS_MATCH_ACCESS_TOKEN");
  });

  it("resolves path from diagnostic code", async () => {
    const { resolvePathFromDiagnosticCode } = await import("../../src/validation/codeActions/path");

    assert.equal(resolvePathFromDiagnosticCode("bindings.0.agentId"), "bindings.0.agentId");
    assert.equal(
      resolvePathFromDiagnosticCode({ value: "gateway.secret" } as unknown as never),
      "gateway.secret",
    );
    assert.equal(resolvePathFromDiagnosticCode({ value: 7 } as unknown as never), null);
  });

  it("checks path existence in document", async () => {
    const { pathExistsInDocument } = await import("../../src/validation/codeActions/path");

    const text = '{\n  "gateway": { "apiKey": "x" },\n  "bindings": [{ "agentId": "a" }]\n}\n';

    assert.equal(pathExistsInDocument(text, "gateway.apiKey"), true);
    assert.equal(pathExistsInDocument(text, "bindings.0.agentId"), true);
    assert.equal(pathExistsInDocument(text, "gateway.missing"), false);
  });
});
