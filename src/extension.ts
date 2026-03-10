import * as vscode from "vscode";
import { createCatalogController } from "./extension/catalog";
import { registerOpenClawCommands } from "./extension/commands";
import { registerOpenClawEvents } from "./extension/events";
import { createSerializedRunner } from "./extension/serializedRunner";
import { readSettings } from "./extension/settings";
import { SchemaArtifactManager } from "./schema/artifactManager";
import { OPENCLAW_SCHEMA_URI } from "./schema/constants";
import { OpenClawSchemaContentProvider } from "./schema/contentProvider";
import { registerOpenClawSubfieldCompletion } from "./templating/subfieldCompletion";
import { isOpenClawConfigDocument } from "./utils";
import { registerOpenClawCodeActions } from "./validation/codeActions";
import { OpenClawIntegratorDiagnostics } from "./validation/integratorDiagnostics";
import { OpenClawZodShadowDiagnostics } from "./validation/zodShadow";
import { registerAutoUpdater } from "./extension/updater";

const BACKGROUND_SYNC_INTERVAL_MS = 15 * 60 * 1_000;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("OpenClaw Config");
  context.subscriptions.push(output);

  const artifacts = new SchemaArtifactManager({ context });
  const schemaProvider = new OpenClawSchemaContentProvider(artifacts);
  const zodShadow = new OpenClawZodShadowDiagnostics(artifacts);
  const integratorDiagnostics = new OpenClawIntegratorDiagnostics();

  registerAutoUpdater(context, output);

  context.subscriptions.push(
    schemaProvider,
    zodShadow,
    integratorDiagnostics,
    vscode.workspace.registerTextDocumentContentProvider("openclaw-schema", schemaProvider),
  );

  registerOpenClawCodeActions(context, {
    isEnabled: () => readSettings().codeActionsEnabled,
  });

  let initialized = false;
  let initializePromise: Promise<void> | null = null;
  let invalidateCatalog: () => void = () => {};

  const validateDocument = async (originalDocument: vscode.TextDocument): Promise<void> => {
    if (!isOpenClawConfigDocument(originalDocument)) {
      return;
    }

    const settings = readSettings();
    let workingDocument = originalDocument;
    if (originalDocument.languageId !== "jsonc") {
      workingDocument = await vscode.languages.setTextDocumentLanguage(originalDocument, "jsonc");
    }

    await Promise.all([
      zodShadow.validateDocument(workingDocument, settings.zodShadowEnabled),
      integratorDiagnostics.validateDocument(workingDocument, {
        strictSecrets: settings.strictSecrets,
      }),
    ]);
  };

  const ensureInitialized = async (reason: string): Promise<void> => {
    if (initialized) {
      return;
    }
    if (initializePromise) {
      await initializePromise;
      return;
    }

    initializePromise = (async () => {
      const settings = readSettings();
      artifacts.configureRemote({
        manifestUrl: settings.manifestUrl,
        schemaVersion: settings.schemaVersion,
        securityPolicy: {
          requireHttps: true,
          allowedHosts: settings.allowedHosts,
          allowedRepositories: settings.allowedRepositories,
        },
      });

      const initialSync = await artifacts.initialize(settings.ttlHours);
      output.appendLine(`[init:${reason}] ${initialSync.message}`);
      initialized = true;
      invalidateCatalog();

      await Promise.all(
        vscode.workspace.textDocuments
          .filter((document) => isOpenClawConfigDocument(document))
          .map((document) => validateDocument(document)),
      );

      if (initialSync.updated) {
        schemaProvider.refresh();
        await refreshJsonSchema(output);
      }
    })();

    try {
      await initializePromise;
    } finally {
      initializePromise = null;
    }
  };

  const syncAndRefresh = createSerializedRunner(async (force: boolean) => {
    await ensureInitialized(force ? "manual-refresh" : "sync");
    const settings = readSettings();
    const result = await artifacts.syncIfNeeded(settings.ttlHours, force);
    output.appendLine(`[sync] ${result.message}`);

    if (result.updated || force) {
      invalidateCatalog();
      schemaProvider.refresh();
      await Promise.all([
        zodShadow.revalidateAll(settings.zodShadowEnabled),
        integratorDiagnostics.revalidateAll({
          strictSecrets: settings.strictSecrets,
        }),
      ]);
      await refreshJsonSchema(output);
    }
  });

  const catalog = createCatalogController({
    artifacts,
    output,
    readSettings,
    ensureInitialized,
    getWorkspaceRoot: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
  });
  invalidateCatalog = catalog.invalidateCatalog;

  registerOpenClawSubfieldCompletion(context, {
    getCatalog: catalog.getCatalog,
  });

  registerOpenClawEvents({
    context,
    artifacts,
    zodShadow,
    integratorDiagnostics,
    ensureInitialized,
    validateDocument,
    readSettings,
    isInitialized: () => initialized,
    getCatalog: catalog.getCatalog,
    invalidateCatalog,
    syncAndRefresh,
  });

  registerOpenClawCommands({
    context,
    artifacts,
    output,
    ensureInitialized,
    syncAndRefresh,
    validateDocument,
    getCatalog: catalog.getCatalog,
    getPluginEntries: catalog.getPluginEntries,
  });

  const backgroundSync = setInterval(() => {
    if (!initialized) {
      return;
    }
    void syncAndRefresh(false).catch((error) => {
      output.appendLine(`[sync] Background sync failed: ${toErrorMessage(error)}`);
    });
  }, BACKGROUND_SYNC_INTERVAL_MS);
  context.subscriptions.push({
    dispose: () => clearInterval(backgroundSync),
  });

  const hasOpenDocuments = vscode.workspace.textDocuments.some((document) =>
    isOpenClawConfigDocument(document),
  );
  if (hasOpenDocuments) {
    void ensureInitialized("startup-open-document");
  }

  output.appendLine(`[schema] Active schema URI: ${OPENCLAW_SCHEMA_URI}`);
}

export function deactivate(): void {
  // no-op
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function refreshJsonSchema(output: vscode.OutputChannel): Promise<void> {
  try {
    await vscode.commands.executeCommand("json.schema.refresh");
  } catch (error) {
    const message = toErrorMessage(error);
    if (isMissingCommandError(message, "json.schema.refresh")) {
      output.appendLine("[schema] json.schema.refresh is unavailable in this host. Skipping refresh.");
      return;
    }
    throw error;
  }
}

function isMissingCommandError(message: string, commandId: string): boolean {
  return (
    message.toLowerCase().includes(commandId.toLowerCase()) &&
    message.toLowerCase().includes("not found")
  );
}
