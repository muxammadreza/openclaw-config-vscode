import fs from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { CONFIG_FILE_NAME } from "../schema/constants";
import { buildFieldExplainMarkdown, findPathAtOffset } from "../schema/explain";
import type { DynamicSubfieldCatalog, PluginHintEntry, ResolvedSchemaStatus } from "../schema/types";
import { buildDynamicSectionSnippets } from "../templating/dynamicCatalog";
import { normalizeOpenClawConfigText } from "../templating/normalize";
import { SECTION_SNIPPETS, STARTER_TEMPLATE } from "../templating/templates";
import { isOpenClawConfigDocument } from "../utils";
import { applyQuickFix } from "../validation/codeActions";

type CommandRegistrationOptions = {
  context: vscode.ExtensionContext;
  artifacts: {
    getSchemaText: () => Promise<string>;
    getUiHintsText: () => Promise<string>;
    getStatus: () => Promise<ResolvedSchemaStatus>;
  };
  output: vscode.OutputChannel;
  ensureInitialized: (reason: string) => Promise<void>;
  syncAndRefresh: (force: boolean) => Promise<void>;
  validateDocument: (document: vscode.TextDocument) => Promise<void>;
  getCatalog: () => Promise<DynamicSubfieldCatalog | null>;
  getPluginEntries: () => readonly PluginHintEntry[];
};

export function registerOpenClawCommands(options: CommandRegistrationOptions): void {
  options.context.subscriptions.push(
    vscode.commands.registerCommand("openclawConfig.refreshSchemaNow", async () => {
      await options.syncAndRefresh(true);
      void vscode.window.showInformationMessage("OpenClaw schema refresh completed.");
    }),
    vscode.commands.registerCommand("openclawConfig.showSchemaStatus", async () => {
      await options.ensureInitialized("show-status");
      const status = await options.artifacts.getStatus();

      const lines = [
        `source: ${status.artifacts.source}`,
        `manifestUrl: ${status.artifacts.manifestUrl}`,
        `openclawCommit: ${status.artifacts.openclawCommit ?? "n/a"}`,
        `generatedAt: ${status.artifacts.generatedAt ?? "n/a"}`,
        `lastCheckedAt: ${status.artifacts.lastCheckedAt ?? "n/a"}`,
        `lastSuccessfulSyncAt: ${status.artifacts.lastSuccessfulSyncAt ?? "n/a"}`,
        `lastError: ${status.artifacts.lastError ?? "none"}`,
        `policy.manifest.allowed: ${status.artifacts.policy.manifest.allowed}`,
        `policy.manifest.reason: ${status.artifacts.policy.manifest.reason}`,
        `pluginDiscovery.source: ${status.pluginDiscovery.source}`,
        `pluginDiscovery.commandPath: ${status.pluginDiscovery.commandPath}`,
        `pluginDiscovery.pluginCount: ${status.pluginDiscovery.pluginCount}`,
        `pluginDiscovery.channelCount: ${status.pluginDiscovery.channelCount}`,
        `pluginDiscovery.providerCount: ${status.pluginDiscovery.providerCount}`,
        `pluginDiscovery.schemaBackedSurfaceCount: ${status.pluginDiscovery.schemaBackedSurfaceCount}`,
        `pluginDiscovery.assistiveOnlySurfaceCount: ${status.pluginDiscovery.assistiveOnlySurfaceCount}`,
        `pluginDiscovery.codeTraversalMode: ${status.pluginDiscovery.codeTraversalMode}`,
        `pluginDiscovery.confidence.explicit: ${status.pluginDiscovery.confidence.explicit}`,
        `pluginDiscovery.confidence.derived: ${status.pluginDiscovery.confidence.derived}`,
        `pluginDiscovery.confidence.inferred: ${status.pluginDiscovery.confidence.inferred}`,
        `pluginDiscovery.lastError: ${status.pluginDiscovery.lastError ?? "none"}`,
        `pluginDiscovery.lastTraversalError: ${status.pluginDiscovery.lastTraversalError ?? "none"}`,
        `runtime.available: ${status.runtime.available}`,
        `runtime.commandPath: ${status.runtime.commandPath}`,
        `runtime.version: ${status.runtime.version ?? "n/a"}`,
        `runtime.versionTag: ${status.runtime.versionTag ?? "n/a"}`,
        `runtime.configPath: ${status.runtime.configPath ?? "n/a"}`,
        `runtime.validatorSupportsJson: ${status.runtime.validatorSupportsJson}`,
        `runtime.lastError: ${status.runtime.lastError ?? "none"}`,
        `resolvedSchema.requestedVersion: ${status.resolvedSchema.requestedVersion}`,
        `resolvedSchema.resolvedVersion: ${status.resolvedSchema.resolvedVersion ?? "n/a"}`,
        `resolvedSchema.source: ${status.resolvedSchema.source}`,
        `resolvedSchema.versionMatched: ${status.resolvedSchema.versionMatched}`,
      ];
      if (status.artifacts.policy.artifacts.length > 0) {
        lines.push(`policy.artifacts.count: ${status.artifacts.policy.artifacts.length}`);
        status.artifacts.policy.artifacts.forEach((evaluation, index) => {
          lines.push(`policy.artifacts[${index}].allowed: ${evaluation.allowed}`);
          lines.push(`policy.artifacts[${index}].reason: ${evaluation.reason}`);
          lines.push(`policy.artifacts[${index}].host: ${evaluation.host ?? "n/a"}`);
          lines.push(`policy.artifacts[${index}].repository: ${evaluation.repository ?? "n/a"}`);
        });
      }

      options.output.appendLine("[status] OpenClaw schema status");
      for (const line of lines) {
        options.output.appendLine(`[status] ${line}`);
      }
      options.output.show(true);

      void vscode.window.showInformationMessage(
        `OpenClaw runtime=${status.runtime.version ?? "n/a"}, schema=${status.resolvedSchema.resolvedVersion ?? "live"}`,
      );
    }),
    vscode.commands.registerCommand("openclawConfig.newConfig", async () => {
      await options.ensureInitialized("new-config");
      await createNewConfigFile();
      const active = vscode.window.activeTextEditor?.document;
      if (active && isOpenClawConfigDocument(active)) {
        await options.validateDocument(active);
      }
    }),
    vscode.commands.registerCommand("openclawConfig.insertSectionSnippet", async () => {
      await options.ensureInitialized("insert-snippet");
      const editor = vscode.window.activeTextEditor;
      if (!editor || !isOpenClawConfigDocument(editor.document)) {
        await vscode.window.showWarningMessage("Open an openclaw.json file first.");
        return;
      }

      await options.getCatalog();
      const snippets = await buildDynamicSectionSnippets(
        options.artifacts,
        SECTION_SNIPPETS,
        options.getPluginEntries(),
      );
      const picked = await vscode.window.showQuickPick(
        snippets.map((item) => ({
          label: item.label,
          description: item.description,
          body: item.body,
        })),
        { placeHolder: "Select an OpenClaw section snippet" },
      );
      if (!picked) {
        return;
      }

      await editor.insertSnippet(new vscode.SnippetString(picked.body), editor.selection.active);
    }),
    vscode.commands.registerCommand("openclawConfig.explainSelection", async () => {
      await options.ensureInitialized("explain-selection");
      const editor = vscode.window.activeTextEditor;
      if (!editor || !isOpenClawConfigDocument(editor.document)) {
        await vscode.window.showWarningMessage("Open an openclaw.json file first.");
        return;
      }

      const catalog = await options.getCatalog();
      if (!catalog) {
        await vscode.window.showWarningMessage("Dynamic schema catalog is not available yet.");
        return;
      }

      const pathAtCursor =
        findPathAtOffset(editor.document.getText(), editor.document.offsetAt(editor.selection.active)) ??
        "";
      const markdown = buildFieldExplainMarkdown(
        pathAtCursor,
        catalog,
        await options.artifacts.getUiHintsText(),
      );

      const doc = await vscode.workspace.openTextDocument({
        language: "markdown",
        content: markdown,
      });
      await vscode.window.showTextDocument(doc, { preview: false });
    }),
    vscode.commands.registerCommand("openclawConfig.normalizeConfig", async () => {
      await options.ensureInitialized("normalize-config");
      const editor = vscode.window.activeTextEditor;
      if (!editor || !isOpenClawConfigDocument(editor.document)) {
        await vscode.window.showWarningMessage("Open an openclaw.json file first.");
        return;
      }

      const nextText = normalizeOpenClawConfigText(
        editor.document.getText(),
        await options.artifacts.getUiHintsText(),
      );
      if (nextText === null) {
        await vscode.window.showWarningMessage("Cannot normalize: openclaw.json is not valid JSONC.");
        return;
      }

      if (nextText !== editor.document.getText()) {
        const fullRange = new vscode.Range(
          editor.document.positionAt(0),
          editor.document.positionAt(editor.document.getText().length),
        );
        await editor.edit((builder) => builder.replace(fullRange, nextText));
        await editor.document.save();
      }

      await options.validateDocument(editor.document);
      void vscode.window.showInformationMessage("OpenClaw config normalized.");
    }),
    vscode.commands.registerCommand("openclawConfig.applyQuickFix", async (payload) => {
      await options.ensureInitialized("apply-quick-fix");
      await applyQuickFix(payload);
      const editor = vscode.window.activeTextEditor?.document;
      if (editor && isOpenClawConfigDocument(editor)) {
        await options.validateDocument(editor);
      }
    }),
  );
}

async function createNewConfigFile(): Promise<void> {
  const targetWorkspace = vscode.workspace.workspaceFolders?.[0];

  if (!targetWorkspace) {
    const document = await vscode.workspace.openTextDocument({
      content: STARTER_TEMPLATE,
      language: "jsonc",
    });
    await vscode.window.showTextDocument(document, { preview: false });
    return;
  }

  const targetPath = path.join(targetWorkspace.uri.fsPath, CONFIG_FILE_NAME);
  try {
    await fs.access(targetPath);
  } catch {
    await fs.writeFile(targetPath, STARTER_TEMPLATE, "utf8");
  }

  const document = await vscode.workspace.openTextDocument(targetPath);
  await vscode.window.showTextDocument(document, { preview: false });
}
