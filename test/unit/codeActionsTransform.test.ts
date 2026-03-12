import assert from "node:assert/strict";
import { parse } from "jsonc-parser";
import { describe, it } from "vitest";

describe("codeActions transform", () => {
  it("sets $schema field", async () => {
    const { computeQuickFixText } = await import("../../src/validation/codeActions/text");

    const payload = {
      kind: "setSchema",
      uri: "file:///tmp/openclaw.json",
    } as const;

    const next = computeQuickFixText("{}\n", payload);
    assert.ok(next);
    assert.match(next!, /"\$schema"/);
    assert.match(next!, /openclaw-schema:\/\/live\/openclaw\.schema\.json/);
  });

  it("removes unknown key by path", async () => {
    const { computeQuickFixText } = await import("../../src/validation/codeActions/text");

    const input = '{\n  "foo": 1,\n  "bar": 2\n}\n';
    const next = computeQuickFixText(input, {
      kind: "removeUnknownKey",
      uri: "file:///tmp/openclaw.json",
      path: "foo",
    });

    assert.ok(next);
    const parsed = parse(next!);
    assert.deepEqual(parsed, { bar: 2 });
  });

  it("removes invalid binding entry", async () => {
    const { computeQuickFixText } = await import("../../src/validation/codeActions/text");

    const input = '{\n  "bindings": [{"agentId": "a"}, {"agentId": "b"}]\n}\n';
    const next = computeQuickFixText(input, {
      kind: "removeInvalidBinding",
      uri: "file:///tmp/openclaw.json",
      path: "bindings.1",
    });

    assert.ok(next);
    const parsed = parse(next!);
    assert.deepEqual(parsed, { bindings: [{ agentId: "a" }] });
  });

  it("replaces secret value with env reference", async () => {
    const { computeQuickFixText } = await import("../../src/validation/codeActions/text");

    const input = '{\n  "gateway": { "apiKey": "plain" }\n}\n';
    const next = computeQuickFixText(input, {
      kind: "replaceSecretWithEnvRef",
      uri: "file:///tmp/openclaw.json",
      path: "gateway.apiKey",
    });

    assert.ok(next);
    const parsed = JSON.parse(next!);
    assert.equal(parsed.gateway.apiKey, "${env:OPENCLAW_GATEWAY_APIKEY}");
  });

  it("removes duplicate agentDir overrides", async () => {
    const { computeQuickFixText } = await import("../../src/validation/codeActions/text");

    const input =
      '{\n  "agents": {\n    "list": [\n      { "id": "alpha", "agentDir": "./a" },\n      { "id": "beta", "agentDir": "./b1" },\n      { "id": "beta", "agentDir": "./b2" }\n    ]\n  }\n}\n';

    const diagnosticMessage = 'Duplicate agentDir detected: "alpha", "beta"';
    const next = computeQuickFixText(input, {
      kind: "removeDuplicateAgentDir",
      uri: "file:///tmp/openclaw.json",
      diagnosticMessage,
    });

    assert.ok(next);
    const parsed = JSON.parse(next!);
    assert.equal(parsed.agents.list[0].agentDir, "./a");
    assert.equal("agentDir" in parsed.agents.list[1], false);
    assert.equal("agentDir" in parsed.agents.list[2], false);
  });
});
