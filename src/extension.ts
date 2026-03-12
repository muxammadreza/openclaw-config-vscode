import * as vscode from "vscode";
import { createCatalogController } from "./extension/catalog";
import { registerOpenClawCommands } from "./extension/commands";
import { registerOpenClawEvents } from "./extension/events";
import { createSerializedRunner } from "./extension/serializedRunner";
import { readSettings } from "./extension/settings";
import { OpenClawJsonLanguageService } from "./language/jsonLanguageService";
import { LocalRuntimeProfileService } from "./runtime/localRuntimeProfile";
import { SchemaArtifactManager } from "./schema/artifactManager";
import { OPENCLAW_SCHEMA_URI } from "./schema/constants";
import { OpenClawSchemaContentProvider } from "./schema/contentProvider";
import { ResolvedSchemaService } from "./schema/resolvedArtifacts";
import { registerOpenClawSubfieldCompletion } from "./templating/subfieldCompletion";
import { isOpenClawConfigDocument } from "./utils";
import { registerOpenClawCodeActions } from "./validation/codeActions";
import { OpenClawIntegratorDiagnostics } from "./validation/integratorDiagnostics";
import { OpenClawPluginDiagnostics } from "./validation/pluginDiagnostics";
import { OpenClawRuntimeValidatorDiagnostics } from "./validation/runtimeValidator";
import { registerAutoUpdater } from "./extension/updater";

const BACKGROUND_SYNC_INTERVAL_MS = 15 * 60 * 1_000;

export type OpenClawExtensionApi = {
  getGlobalStoragePath: () => string;
};

export async function activate(context: vscode.ExtensionContext): Promise<OpenClawExtensionApi> {
  const output = vscode.window.createOutputChannel("OpenClaw Config");
  context.subscriptions.push(output);

  const artifacts = new SchemaArtifactManager({ context });
  const runtimeProfiles = new LocalRuntimeProfileService({ output });
  const resolvedArtifacts = new ResolvedSchemaService({
    artifacts,
    output,
    readSettings,
    getWorkspaceRoot: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    runtimeProfiles,
  });
  const schemaProvider = new OpenClawSchemaContentProvider();
  const jsonLanguageService = new OpenClawJsonLanguageService({
    artifacts: resolvedArtifacts,
    output,
  });
  const runtimeValidator = new OpenClawRuntimeValidatorDiagnostics({
    output,
    getWorkspaceRoot: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
  });
  const integratorDiagnostics = new OpenClawIntegratorDiagnostics();
  const pluginDiagnostics = new OpenClawPluginDiagnostics();

  registerAutoUpdater(context, output);

  context.subscriptions.push(
    schemaProvider,
    jsonLanguageService,
    runtimeValidator,
    integratorDiagnostics,
    pluginDiagnostics,
    vscode.workspace.registerTextDocumentContentProvider("openclaw-schema", schemaProvider),
  );

  jsonLanguageService.registerProviders(context);

  registerOpenClawCodeActions(context, {
    isEnabled: () => readSettings().codeActionsEnabled,
  });

  let initialized = false;
  let initializePromise: Promise<void> | null = null;
  let startupSyncPromise: Promise<void> | null = null;
  let invalidateCatalog: () => void = () => {};

  const refreshPluginDiagnostics = async (
    document?: vscode.TextDocument,
  ): Promise<void> => {
    try {
      const discovery = await resolvedArtifacts.getDiscoveryResult();
      if (document) {
        await pluginDiagnostics.validateDocument(document, { discovery });
        return;
      }
      await pluginDiagnostics.revalidateAll({ discovery });
    } catch (error) {
      output.appendLine(`[plugins] Failed to refresh plugin diagnostics: ${toErrorMessage(error)}`);
    }
  };

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
      jsonLanguageService.validateDocument(workingDocument),
      runtimeValidator.validateDocument(
        workingDocument,
        await runtimeProfiles.getProfile({
          commandPath: settings.pluginCommandPath,
          workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        }),
      ),
      integratorDiagnostics.validateDocument(workingDocument, {
        strictSecrets: settings.strictSecrets,
      }),
    ]);
    void refreshPluginDiagnostics(workingDocument);
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
      const runtime = await runtimeProfiles.getProfile({
        commandPath: settings.pluginCommandPath,
        workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      });
      artifacts.configureRemote({
        manifestUrl: settings.manifestUrl,
        schemaVersion:
          settings.schemaVersion !== "latest"
            ? settings.schemaVersion
            : runtime.versionTag,
        securityPolicy: {
          requireHttps: true,
          allowedHosts: settings.allowedHosts,
          allowedRepositories: settings.allowedRepositories,
        },
      });
      initialized = true;
      resolvedArtifacts.invalidate();
      jsonLanguageService.invalidateSchema();
      invalidateCatalog();

      startupSyncPromise ??= artifacts.initialize(settings.ttlHours)
        .then(async (initialSync) => {
          output.appendLine(`[init:${reason}] ${initialSync.message}`);
          if (!initialSync.updated) {
            return;
          }
          resolvedArtifacts.invalidate();
          jsonLanguageService.invalidateSchema();
          invalidateCatalog();
          schemaProvider.refresh();
          await revalidateOpenClawDocuments(runtime);
        })
        .catch((error) => {
          output.appendLine(`[init:${reason}] Schema warmup failed: ${toErrorMessage(error)}`);
        })
        .finally(() => {
          startupSyncPromise = null;
        });

      await Promise.all(
        vscode.workspace.textDocuments
          .filter((document) => isOpenClawConfigDocument(document))
          .map((document) => validateDocument(document)),
      );
    })();

    try {
      await initializePromise;
    } finally {
      initializePromise = null;
    }
  };

  const revalidateOpenClawDocuments = async (
    runtime?: Awaited<ReturnType<typeof runtimeProfiles.getProfile>>,
  ) => {
    const settings = readSettings();
    const effectiveRuntime =
      runtime ??
      (await runtimeProfiles.getProfile({
        commandPath: settings.pluginCommandPath,
        workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      }));
    await Promise.all([
      jsonLanguageService.revalidateAll(),
      runtimeValidator.revalidateAll(effectiveRuntime),
      integratorDiagnostics.revalidateAll({
        strictSecrets: settings.strictSecrets,
      }),
    ]);
    void refreshPluginDiagnostics();
  };

  const syncAndRefresh = createSerializedRunner(async (force: boolean) => {
    await ensureInitialized(force ? "manual-refresh" : "sync");
    if (startupSyncPromise) {
      await startupSyncPromise;
    }
    const settings = readSettings();
    runtimeProfiles.invalidate();
    const runtime = await runtimeProfiles.getProfile({
      commandPath: settings.pluginCommandPath,
      workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    });
    artifacts.configureRemote({
      manifestUrl: settings.manifestUrl,
      schemaVersion:
        settings.schemaVersion !== "latest"
          ? settings.schemaVersion
          : runtime.versionTag,
      securityPolicy: {
        requireHttps: true,
        allowedHosts: settings.allowedHosts,
        allowedRepositories: settings.allowedRepositories,
      },
    });
    const result = await artifacts.syncIfNeeded(settings.ttlHours, force);
    output.appendLine(`[sync] ${result.message}`);

    if (result.updated || force) {
      resolvedArtifacts.invalidate();
      jsonLanguageService.invalidateSchema();
      invalidateCatalog();
      schemaProvider.refresh();
      await revalidateOpenClawDocuments(runtime);
    }
    return result;
  });

  const rebuildSchema = createSerializedRunner(async (_unused: undefined) => {
    if (startupSyncPromise) {
      await startupSyncPromise;
    }
    const settings = readSettings();
    runtimeProfiles.invalidate();
    await artifacts.clearCache();
    resolvedArtifacts.invalidate();
    jsonLanguageService.invalidateSchema();
    invalidateCatalog();

    const runtime = await runtimeProfiles.getProfile({
      commandPath: settings.pluginCommandPath,
      workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    });
    artifacts.configureRemote({
      manifestUrl: settings.manifestUrl,
      schemaVersion:
        settings.schemaVersion !== "latest"
          ? settings.schemaVersion
          : runtime.versionTag,
      securityPolicy: {
        requireHttps: true,
        allowedHosts: settings.allowedHosts,
        allowedRepositories: settings.allowedRepositories,
      },
    });
    const result = await artifacts.syncIfNeeded(settings.ttlHours, true);
    output.appendLine(`[rebuild] ${result.message}`);
    schemaProvider.refresh();
    await revalidateOpenClawDocuments(runtime);
    return result;
  });

  const catalog = createCatalogController({
    artifacts: resolvedArtifacts,
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
    artifacts: resolvedArtifacts,
    jsonLanguageService,
    runtimeValidator,
    integratorDiagnostics,
    pluginDiagnostics,
    runtimeProfiles,
    configureRemote: (options) => artifacts.configureRemote(options),
    invalidateResolvedArtifacts: () => resolvedArtifacts.invalidate(),
    ensureInitialized,
    validateDocument,
    getDiscoveryResult: () => resolvedArtifacts.getDiscoveryResult(),
    readSettings,
    isInitialized: () => initialized,
    getCatalog: catalog.getCatalog,
    invalidateCatalog,
    syncAndRefresh,
  });

  registerOpenClawCommands({
    context,
    artifacts: resolvedArtifacts,
    output,
    ensureInitialized,
    syncAndRefresh,
    rebuildSchema: () => rebuildSchema(undefined),
    validateDocument,
    getSchemaLookup: (pathExpression: string) => resolvedArtifacts.getSchemaLookup(pathExpression),
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
    void ensureInitialized("startup-open-document")
      .then(() => catalog.getCatalog())
      .catch((error) => {
        output.appendLine(`[init:startup-open-document] Prewarm failed: ${toErrorMessage(error)}`);
      });
  }

  output.appendLine(`[schema] Active schema URI: ${OPENCLAW_SCHEMA_URI}`);
  output.appendLine("[schema] Primary editor engine: embedded vscode-json-languageservice");

  return {
    getGlobalStoragePath: () => context.globalStorageUri.fsPath,
  };
}

export function deactivate(): void {
  // no-op
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
