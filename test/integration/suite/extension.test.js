const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

const EXTENSION_ID = "muxammadreza.openclaw-config-vscode";
const createdTempDirs = new Set();
const createdWorkspaceArtifacts = new Set();

suite("OpenClaw Extension Integration", () => {
  test("activates and returns schema status", async function () {
    this.timeout(90_000);
    const extension = await ensureActivated();
    const status = await vscode.commands.executeCommand("openclawConfig.showSchemaStatus");

    assert.equal(extension.isActive, true);
    assert.ok(status);
    assert.ok(["gateway-rpc", "remote-versioned"].includes(status.resolvedSchema.source));
    assert.ok(status.runtime.commandPath);
  });

  test("registers extension commands", async () => {
    await ensureActivated();

    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("openclawConfig.newConfig"));
    assert.ok(commands.includes("openclawConfig.refreshSchemaNow"));
    assert.ok(commands.includes("openclawConfig.rebuildSchema"));
    assert.ok(commands.includes("openclawConfig.insertSectionSnippet"));
    assert.ok(commands.includes("openclawConfig.explainSelection"));
    assert.ok(commands.includes("openclawConfig.normalizeConfig"));
    assert.ok(commands.includes("openclawConfig.showSchemaStatus"));
    assert.ok(commands.includes("openclawConfig.applyQuickFix"));
  });

  test("validates the repository openclaw.json without false structural or runtime errors", async function () {
    this.timeout(90_000);
    await ensureActivated();
    const sampleDoc = await openSampleDocument();

    await vscode.commands.executeCommand("openclawConfig.refreshSchemaNow");
    await waitForSettledDiagnostics(sampleDoc.uri, 2_000);

    const diagnostics = vscode.languages.getDiagnostics(sampleDoc.uri);
    assert.equal(
      diagnostics.some((item) => item.source === "openclaw-schema"),
      false,
    );
    assert.equal(
      diagnostics.some((item) => item.source === "openclaw-runtime"),
      false,
    );
  });

  test("provides hover and explain content from the sample config", async function () {
    this.timeout(90_000);
    await ensureActivated();
    const sampleDoc = await openSampleDocument();
    await vscode.commands.executeCommand("openclawConfig.refreshSchemaNow");
    await waitForSettledDiagnostics(sampleDoc.uri, 2_000);
    const gatewayOffset = sampleDoc.getText().indexOf('"gateway"');
    assert.notEqual(gatewayOffset, -1);

    const hoverStartedAt = Date.now();
    const hovers = await vscode.commands.executeCommand(
      "vscode.executeHoverProvider",
      sampleDoc.uri,
      sampleDoc.positionAt(gatewayOffset + 1),
    );
    const hoverDurationMs = Date.now() - hoverStartedAt;
    assert.ok(Array.isArray(hovers));
    assert.ok(hovers.length > 0);
    assert.match(flattenHoverText(hovers), /Gateway/i);
    assert.ok(
      hoverDurationMs < 500,
      `hover was too slow after warmup: ${hoverDurationMs}ms`,
    );

    const editor = await vscode.window.showTextDocument(sampleDoc, { preview: false });
    const cursor = sampleDoc.positionAt(gatewayOffset + 1);
    editor.selection = new vscode.Selection(cursor, cursor);
    await vscode.commands.executeCommand("openclawConfig.explainSelection");

    await waitFor(() => vscode.window.activeTextEditor?.document.languageId === "markdown", 20_000);
    const markdownDoc = vscode.window.activeTextEditor.document;
    assert.match(markdownDoc.getText(), /Gateway/i);
    assert.match(markdownDoc.getText(), /port|mode|bind/i);
  });

  test("provides key and value completion on a sample-derived fixture", async function () {
    this.timeout(90_000);
    await ensureActivated();
    const extension = await getExtension();
    const pluginHintPath = path.join(extension.extensionPath, ".openclaw", "plugin-hints.json");
    await fs.mkdir(path.dirname(pluginHintPath), { recursive: true });
    await fs.writeFile(
      pluginHintPath,
      JSON.stringify(
        {
          version: 1,
          entries: [
            {
              path: "channels.whatsapp.accounts.*",
              properties: {
                dynamicMode: {
                  description: "Dynamic mode from plugin hints",
                  enumValues: ["strict", "relaxed"],
                  defaultValue: "strict",
                },
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    createdWorkspaceArtifacts.add(pluginHintPath);

    const keyFixture = withMarker(
      `{
  "$schema": "openclaw-schema://live/openclaw.schema.json",
  "channels": {
    "whatsapp": {
      "accounts": {
        "default": {
          __KEY__
        }
      }
    }
  }
}`,
      "__KEY__",
    );
    const keyDoc = await writeAndOpenTempConfig("completion-key", keyFixture.text);
    await vscode.commands.executeCommand("openclawConfig.refreshSchemaNow");

    const keyCompletion = await waitForCompletionItems(keyDoc, keyFixture.offset, (labels) =>
      labels.includes("dynamicMode"),
    );
    const keyLabels = keyCompletion.map((item) => normalizeLabel(item.label));
    assert.ok(keyLabels.includes("dynamicMode"));

    const valueFixture = withMarker(
      `{
  "$schema": "openclaw-schema://live/openclaw.schema.json",
  "channels": {
    "whatsapp": {
      "accounts": {
        "default": {
          "dynamicMode": __VALUE__
        }
      }
    }
  }
}`,
      "__VALUE__",
    );
    const valueDoc = await writeAndOpenTempConfig("completion-value", valueFixture.text);
    const valueCompletion = await waitForCompletionItems(valueDoc, valueFixture.offset, (labels) =>
      labels.includes('"strict"') && labels.includes('"relaxed"'),
    );
    const valueLabels = valueCompletion.map((item) => normalizeLabel(item.label));
    assert.ok(valueLabels.includes('"strict"'));
    assert.ok(valueLabels.includes('"relaxed"'));
  });

  test("normalizes a minified sample-derived config", async function () {
    this.timeout(90_000);
    await ensureActivated();
    const sampleText = await readSampleText();
    const minified = JSON.stringify(JSON.parse(sampleText));
    const doc = await writeAndOpenTempConfig("normalize", minified);

    await vscode.commands.executeCommand("openclawConfig.normalizeConfig");
    await waitFor(async () => {
      const updated = await fs.readFile(doc.uri.fsPath, "utf8");
      return updated !== minified && updated.includes("\n  ");
    }, 20_000);

    const updated = await fs.readFile(doc.uri.fsPath, "utf8");
    assert.notEqual(updated, minified);
    assert.doesNotThrow(() => JSON.parse(updated));
  });

  test("offers and applies quick fixes for unknown keys and cleartext secrets", async function () {
    this.timeout(90_000);
    await ensureActivated();
    const parsed = JSON.parse(await readSampleText());
    parsed.gateway = parsed.gateway ?? {};
    parsed.gateway.ghostSetting = true;
    const doc = await writeAndOpenTempConfig("quick-fix", JSON.stringify(parsed, null, 2));

    await vscode.commands.executeCommand("openclawConfig.refreshSchemaNow");
    await waitForSettledDiagnostics(doc.uri, 2_000);

    let diagnostics = await waitForDiagnostics(doc.uri, (items) =>
      items.some((item) =>
        item.source === "openclaw-schema" &&
        /unknown|not allowed|additional properties/i.test(item.message),
      ),
    );
    const unknownDiagnostic = diagnostics.find((item) =>
      item.source === "openclaw-schema" &&
      /unknown|not allowed|additional properties/i.test(item.message),
    );
    assert.ok(unknownDiagnostic, "missing schema diagnostic for unknown key");

    const unknownActions = await getCodeActions(doc.uri, unknownDiagnostic.range);
    const removeUnknown = unknownActions.find((item) => item.title === 'Remove unknown key "ghostSetting"');
    assert.ok(removeUnknown, "missing remove unknown key action");
    await executeCodeAction(removeUnknown);

    await waitFor(async () => !(await fs.readFile(doc.uri.fsPath, "utf8")).includes("ghostSetting"), 20_000);

    await vscode.commands.executeCommand("openclawConfig.refreshSchemaNow");
    diagnostics = await waitForDiagnostics(doc.uri, (items) =>
      items.some((item) =>
        item.source === "openclaw-advisory" &&
        String(item.code ?? "").includes("gateway.auth.token"),
      ),
    );
    const secretDiagnostic = diagnostics.find((item) =>
      item.source === "openclaw-advisory" &&
      String(item.code ?? "").includes("gateway.auth.token"),
    );
    assert.ok(secretDiagnostic, "missing advisory diagnostic for gateway.auth.token");

    const secretActions = await getCodeActions(doc.uri, secretDiagnostic.range);
    const replaceSecret = secretActions.find((item) =>
      item.title === "Replace secret with ${env:...}",
    );
    assert.ok(replaceSecret, "missing replace secret quick fix");
    await executeCodeAction(replaceSecret);

    await waitFor(async () => {
      const nextText = await fs.readFile(doc.uri.fsPath, "utf8");
      return nextText.includes("${env:GATEWAY_AUTH_TOKEN}");
    }, 20_000);
  });

  test("rebuilds schema, clears stale caches, and works through remote fallback against the sample config", async function () {
    this.timeout(120_000);
    const extension = await ensureActivated();
    const api = extension.exports;
    assert.ok(api && typeof api.getGlobalStoragePath === "function");

    const globalStoragePath = api.getGlobalStoragePath();
    const staleFile = path.join(globalStoragePath, "schema-cache", "stale.txt");
    await fs.mkdir(path.dirname(staleFile), { recursive: true });
    await fs.writeFile(staleFile, "stale", "utf8");

    const config = vscode.workspace.getConfiguration("openclawConfig");
    const previous = config.get("schema.preferredSource");

    try {
      await config.update("schema.preferredSource", "remote", vscode.ConfigurationTarget.Global);
      const rebuildResult = await vscode.commands.executeCommand("openclawConfig.rebuildSchema");
      assert.ok(rebuildResult);
      assert.equal(await pathExists(staleFile), false);
      assert.equal(
        await pathExists(path.join(globalStoragePath, "schema-cache", "live", "manifest.json")),
        true,
      );

      const status = await vscode.commands.executeCommand("openclawConfig.showSchemaStatus");
      assert.equal(status.resolvedSchema.source, "remote-versioned");
      assert.equal(status.artifacts.source, "cache");

      const sampleDoc = await openSampleDocument();
      await waitForSettledDiagnostics(sampleDoc.uri, 2_000);
      const diagnostics = vscode.languages.getDiagnostics(sampleDoc.uri);
      assert.equal(diagnostics.some((item) => item.source === "openclaw-schema"), false);
      assert.equal(diagnostics.some((item) => item.source === "openclaw-runtime"), false);
    } finally {
      await config.update("schema.preferredSource", previous ?? "auto", vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand("openclawConfig.refreshSchemaNow");
    }
  });
});

suiteTeardown(async () => {
  for (const dir of createdTempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  for (const artifactPath of createdWorkspaceArtifacts) {
    await fs.rm(artifactPath, { force: true });
  }
});

async function getExtension() {
  await waitFor(() => Boolean(vscode.extensions.getExtension(EXTENSION_ID)), 30_000);
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension);
  return extension;
}

async function ensureActivated() {
  const extension = await getExtension();
  if (!extension.isActive) {
    await extension.activate();
    await waitFor(() => extension.isActive, 30_000);
  }
  return extension;
}

async function readSampleText() {
  const extension = await getExtension();
  return fs.readFile(path.join(extension.extensionPath, "openclaw.json"), "utf8");
}

async function openSampleDocument() {
  const extension = await getExtension();
  return openDocument(path.join(extension.extensionPath, "openclaw.json"));
}

async function writeAndOpenTempConfig(prefix, text) {
  const extension = await getExtension();
  const testRoot = path.join(extension.extensionPath, ".test-tmp");
  await fs.mkdir(testRoot, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(testRoot, `${prefix}-`));
  createdTempDirs.add(tempDir);
  const configPath = path.join(tempDir, "openclaw.json");
  await fs.writeFile(configPath, text, "utf8");
  return openDocument(configPath);
}

async function openDocument(filePath) {
  const document = await vscode.workspace.openTextDocument(filePath);
  await vscode.window.showTextDocument(document, { preview: false });
  await waitFor(() => {
    const active = vscode.window.activeTextEditor?.document;
    return Boolean(active && active.fileName === filePath && active.languageId === "jsonc");
  }, 20_000);
  return vscode.window.activeTextEditor.document;
}

async function waitForCompletionItems(document, offset, predicate) {
  return waitFor(async () => {
    const completion = await vscode.commands.executeCommand(
      "vscode.executeCompletionItemProvider",
      document.uri,
      document.positionAt(offset),
    );
    if (!completion || !Array.isArray(completion.items)) {
      return false;
    }
    const labels = completion.items.map((item) => normalizeLabel(item.label));
    return predicate(labels) ? completion.items : false;
  }, 45_000);
}

async function waitForSettledDiagnostics(uri, stableForMs) {
  let lastFingerprint = "";
  let stableSince = Date.now();

  await waitFor(async () => {
    const fingerprint = JSON.stringify(
      vscode.languages
        .getDiagnostics(uri)
        .map((item) => ({
          source: item.source,
          code: item.code,
          message: item.message,
          severity: item.severity,
          range: item.range,
        })),
    );
    if (fingerprint !== lastFingerprint) {
      lastFingerprint = fingerprint;
      stableSince = Date.now();
      return false;
    }
    return Date.now() - stableSince >= stableForMs;
  }, 30_000);
}

async function waitForDiagnostics(uri, predicate) {
  return waitFor(async () => {
    const diagnostics = vscode.languages.getDiagnostics(uri);
    return predicate(diagnostics) ? diagnostics : false;
  }, 30_000);
}

async function getCodeActions(uri, range) {
  const actions = await vscode.commands.executeCommand(
    "vscode.executeCodeActionProvider",
    uri,
    range,
  );
  return Array.isArray(actions) ? actions : [];
}

async function executeCodeAction(action) {
  if (action.command) {
    return vscode.commands.executeCommand(
      action.command.command,
      ...(action.command.arguments ?? []),
    );
  }
  if (action.edit) {
    await vscode.workspace.applyEdit(action.edit);
    return;
  }
  throw new Error(`Unsupported code action payload: ${action.title}`);
}

function flattenHoverText(hovers) {
  return hovers
    .flatMap((hover) => hover.contents ?? [])
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      if (typeof entry?.value === "string") {
        return entry.value;
      }
      return "";
    })
    .join("\n");
}

function withMarker(input, marker) {
  const offset = input.indexOf(marker);
  assert.notEqual(offset, -1, `Missing marker: ${marker}`);
  return {
    text: input.replace(marker, ""),
    offset,
  };
}

function normalizeLabel(label) {
  return typeof label === "string" ? label : label?.label ?? "";
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(checkFn, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await checkFn();
    if (result) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}
