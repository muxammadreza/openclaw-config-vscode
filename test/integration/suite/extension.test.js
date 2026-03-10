const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

const EXTENSION_ID = "muxammadreza.openclaw-config-vscode";

suite("OpenClaw Extension Integration", () => {
  test("lazy activation waits until command invocation", async () => {
    const extension = await getExtension();
    assert.equal(extension.isActive, false);

    await vscode.commands.executeCommand("openclawConfig.showSchemaStatus");

    await waitFor(() => extension.isActive, 10_000);
    assert.equal(extension.isActive, true);
  });

  test("registers extension commands", async () => {
    await ensureActivated();

    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("openclawConfig.newConfig"));
    assert.ok(commands.includes("openclawConfig.refreshSchemaNow"));
    assert.ok(commands.includes("openclawConfig.insertSectionSnippet"));
    assert.ok(commands.includes("openclawConfig.explainSelection"));
    assert.ok(commands.includes("openclawConfig.normalizeConfig"));
    assert.ok(commands.includes("openclawConfig.showSchemaStatus"));
    assert.ok(commands.includes("openclawConfig.applyQuickFix"));
  });

  test("forces jsonc mode for openclaw.json", async () => {
    await ensureActivated();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doc-test-"));
    const configPath = path.join(tempDir, "openclaw.json");

    try {
      await fs.writeFile(configPath, "{}\n", "utf8");
      const doc = await vscode.workspace.openTextDocument(configPath);
      await vscode.window.showTextDocument(doc, { preview: false });

      await waitFor(async () => {
        const active = vscode.window.activeTextEditor?.document;
        return Boolean(active && active.fileName === configPath && active.languageId === "jsonc");
      }, 8_000);

      const active = vscode.window.activeTextEditor?.document;
      assert.ok(active);
      assert.equal(active.fileName, configPath);
      assert.equal(active.languageId, "jsonc");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("provides hybrid key/value completion from plugin metadata", async function () {
    this.timeout(60_000);
    await ensureActivated();

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder);
    const workspaceRoot = workspaceFolder.uri.fsPath;
    const metadataPath = path.join(workspaceRoot, ".openclaw", "plugin-hints.json");
    const configPath = path.join(workspaceRoot, "openclaw.json");

    await fs.mkdir(path.dirname(metadataPath), { recursive: true });
    await fs.writeFile(
      metadataPath,
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

    await vscode.commands.executeCommand("openclawConfig.refreshSchemaNow");

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

    await fs.writeFile(configPath, keyFixture.text, "utf8");
    const keyDoc = await vscode.workspace.openTextDocument(configPath);
    await vscode.window.showTextDocument(keyDoc, { preview: false });

    await waitFor(async () => {
      const active = vscode.window.activeTextEditor?.document;
      return Boolean(active && active.fileName === configPath && active.languageId === "jsonc");
    }, 8_000);

    await waitFor(async () => {
      const completion = await vscode.commands.executeCommand(
        "vscode.executeCompletionItemProvider",
        keyDoc.uri,
        keyDoc.positionAt(keyFixture.offset),
      );
      if (!completion || !Array.isArray(completion.items)) {
        return false;
      }
      const match = completion.items.find(
        (item) => normalizeLabel(item.label) === "dynamicMode" && /plugin/i.test(item.detail ?? ""),
      );
      return Boolean(match);
    }, 30_000);

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

    await fs.writeFile(configPath, valueFixture.text, "utf8");
    const valueDoc = await vscode.workspace.openTextDocument(configPath);
    await vscode.window.showTextDocument(valueDoc, { preview: false });

    await waitFor(async () => {
      const completion = await vscode.commands.executeCommand(
        "vscode.executeCompletionItemProvider",
        valueDoc.uri,
        valueDoc.positionAt(valueFixture.offset),
      );
      if (!completion || !Array.isArray(completion.items)) {
        return false;
      }
      const labels = completion.items.map((item) => normalizeLabel(item.label));
      return labels.includes('"strict"') && labels.includes('"relaxed"');
    }, 30_000);
  });
});

async function getExtension() {
  await waitFor(() => Boolean(vscode.extensions.getExtension(EXTENSION_ID)), 10_000);
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension);
  return extension;
}

async function ensureActivated() {
  const extension = await getExtension();
  if (extension.isActive) {
    return extension;
  }
  await extension.activate();
  await waitFor(() => extension.isActive, 10_000);
  return extension;
}

async function waitFor(checkFn, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await checkFn()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
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
