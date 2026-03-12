import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";
import { getLanguageService } from "vscode-json-languageservice";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  assertKeyPresentInCatalog,
  buildHoverMarkdown,
  createSchemaContractMatrix,
} from "../../src/schema/contractMatrix";
import { resolveDynamicSubfieldsWithMatches } from "../../src/schema/dynamicSubfields";
import { buildValueCompletionSuggestions } from "../../src/templating/completion/items";
import { evaluateIntegratorIssues } from "../../src/validation/integratorRules";
import { computeQuickFixText } from "../../src/validation/codeActions/text";
import { toEnvVarName } from "../../src/validation/codeActions/secrets";

const VERSIONED_SCHEMA_ROOT = path.resolve(__dirname, "../../schemas/v2026.3.8");

describe("schema contract coverage", () => {
  const schemaText = fs.readFileSync(path.join(VERSIONED_SCHEMA_ROOT, "openclaw.schema.json"), "utf8");
  const uiHintsText = fs.readFileSync(path.join(VERSIONED_SCHEMA_ROOT, "openclaw.ui-hints.json"), "utf8");
  const matrix = createSchemaContractMatrix(schemaText, uiHintsText);
  const languageService = getLanguageService({});
  const schema = JSON.parse(schemaText) as Record<string, unknown>;
  languageService.configure({
    allowComments: true,
    schemas: [
      {
        uri: "openclaw-contract://schema/openclaw.schema.json",
        fileMatch: ["*"],
        schema,
      },
    ],
  });

  it("covers every discovered key path in the dynamic catalog and hover hints", () => {
    assert.ok(matrix.keyContracts.length > 200, "expected broad key coverage");
    for (const contract of matrix.keyContracts) {
      assert.equal(
        assertKeyPresentInCatalog(contract, matrix.catalog),
        true,
        `missing completion entry for ${contract.parentConcretePath}.${contract.key}`,
      );

      if (!contract.hint?.label && !contract.hint?.help) {
        continue;
      }
      const markdown = buildHoverMarkdown(contract.fullPatternPath, matrix.catalog, uiHintsText);
      assert.match(
        markdown,
        new RegExp(escapeRegExp(contract.hint.label ?? contract.hint.help ?? contract.key), "i"),
        `missing hover hint content for ${contract.fullPatternPath}`,
      );
    }
  });

  it("covers every constrained value path via schema completions", async () => {
    assert.ok(matrix.valueContracts.length > 50, "expected constrained value coverage");
    for (const contract of matrix.valueContracts) {
      const resolutions = resolveDynamicSubfieldsWithMatches(matrix.catalog, contract.parentConcretePath);
      const resolution = resolutions.find((entry) => entry.entry.key === contract.key);
      assert.ok(resolution, `missing dynamic value contract resolution for ${contract.fullConcretePath}`);
      const labels = buildValueCompletionSuggestions(resolution).map((item) => item.label);
      const expectedLabels = contract.values.map((value) =>
        typeof value === "string" ? [`"${value}"`, String(value)] : [String(value)],
      );
      assert.ok(
        expectedLabels.some((candidates) => candidates.some((candidate) => labels.includes(candidate))),
        `missing constrained value completion for ${contract.fullConcretePath}`,
      );
    }
  });

  it("covers strict object unknown-key diagnostics and remove-unknown quick fixes", async () => {
    assert.ok(matrix.strictObjectContracts.length > 20, "expected strict object coverage");
    for (const contract of matrix.strictObjectContracts) {
      const text = buildUnknownFixture(matrix.syntheticConfig, `${contract.path}.${contract.unknownKey}`);
      const diagnostics = await validate(languageService, text);
      assert.ok(
        diagnostics.some((item) => /not allowed|additional propert/i.test(item.message)),
        `missing unknown-key diagnostic for ${contract.path}`,
      );

      const nextText = computeQuickFixText(text, {
        kind: "removeUnknownKey",
        uri: "file:///tmp/openclaw.json",
        path: `${contract.path}.${contract.unknownKey}`,
      });
      assert.ok(nextText);
      assert.equal(nextText?.includes(`"${contract.unknownKey}"`), false);
    }
  });

  it("covers sensitive-path advisory diagnostics and env quick fixes", () => {
    assert.ok(matrix.sensitiveContracts.length > 10, "expected sensitive path coverage");
    for (const contract of matrix.sensitiveContracts) {
      const config = structuredClone(matrix.syntheticConfig);
      assignPath(config, contract.path, "plain-text-secret");
      const issues = evaluateIntegratorIssues(config, { strictSecrets: false });
      assert.ok(
        issues.some((issue) => issue.path === contract.path),
        `missing secret advisory for ${contract.path}`,
      );

      const text = JSON.stringify(config, null, 2);
      const nextText = computeQuickFixText(text, {
        kind: "replaceSecretWithEnvRef",
        uri: "file:///tmp/openclaw.json",
        path: contract.path,
      });
      assert.ok(nextText?.includes(`\${env:${toEnvVarName(contract.path)}}`));
    }
  });
});

async function validate(
  languageService: ReturnType<typeof getLanguageService>,
  text: string,
) {
  const document = TextDocument.create("file:///tmp/openclaw.json", "jsonc", 1, text);
  const jsonDocument = languageService.parseJSONDocument(document);
  return languageService.doValidation(document, jsonDocument, {
    comments: "ignore",
    trailingCommas: "ignore",
    schemaValidation: "error",
    schemaRequest: "ignore",
  });
}

function buildUnknownFixture(baseConfig: Record<string, unknown>, pathExpression: string): string {
  const clone = structuredClone(baseConfig);
  assignPath(clone, pathExpression, true);
  return JSON.stringify(clone, null, 2);
}

function assignPath(root: Record<string, unknown>, pathExpression: string, value: unknown): void {
  let current: Record<string, unknown> | unknown[] = root;
  const segments = pathExpression.split(".").filter(Boolean);

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const isLast = index === segments.length - 1;
    const nextSegment = segments[index + 1];

    if (isArrayIndex(segment)) {
      const array = Array.isArray(current) ? current : [];
      if (!Array.isArray(current)) {
        throw new Error(`Invalid array path placement: ${pathExpression}`);
      }
      const targetIndex = Number(segment);
      if (isLast) {
        array[targetIndex] = value;
        continue;
      }
      const nextContainer = isArrayIndex(nextSegment) ? [] : {};
      array[targetIndex] = array[targetIndex] ?? nextContainer;
      current = array[targetIndex] as Record<string, unknown> | unknown[];
      continue;
    }

    const record = current as Record<string, unknown>;
    if (isLast) {
      record[segment] = value;
      continue;
    }
    const nextContainer = isArrayIndex(nextSegment) ? [] : {};
    record[segment] = record[segment] ?? nextContainer;
    current = record[segment] as Record<string, unknown> | unknown[];
  }

}

function isArrayIndex(value: string | undefined): boolean {
  return Boolean(value && /^\d+$/.test(value));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
