import * as vscode from "vscode";
import { OPENCLAW_DOCUMENT_SELECTOR } from "../extension/documentSelector";
import { OpenClawJsonLanguageService } from "../language/jsonLanguageService";
import { buildFieldExplainMarkdown, findPathAtOffset } from "../schema/explain";
import type { DynamicSubfieldCatalog, SchemaLookupResult } from "../schema/types";
import type { LocalRuntimeProfileService } from "../runtime/localRuntimeProfile";
import { isOpenClawConfigDocument } from "../utils";
import type { OpenClawIntegratorDiagnostics } from "../validation/integratorDiagnostics";
import type { OpenClawPluginDiagnostics } from "../validation/pluginDiagnostics";
import type { OpenClawRuntimeValidatorDiagnostics } from "../validation/runtimeValidator";
import { cancelPendingValidation, clearAllPendingValidations } from "./pendingValidation";
import type { ExtensionSettings } from "./settings";

type EventRegistrationOptions = {
  context: vscode.ExtensionContext;
  artifacts: {
    getUiHintsText: () => Promise<string>;
    getSchemaLookup?: (pathExpression: string) => Promise<SchemaLookupResult | null>;
  };
  jsonLanguageService: Pick<OpenClawJsonLanguageService, "clear" | "revalidateAll">;
  runtimeValidator: Pick<OpenClawRuntimeValidatorDiagnostics, "clear" | "revalidateAll">;
  integratorDiagnostics: Pick<OpenClawIntegratorDiagnostics, "clear" | "revalidateAll">;
  pluginDiagnostics: Pick<OpenClawPluginDiagnostics, "clear" | "revalidateAll">;
  runtimeProfiles: Pick<LocalRuntimeProfileService, "invalidate" | "getProfile">;
  configureRemote: (options: {
    manifestUrl?: string;
    schemaVersion?: string;
    securityPolicy?: {
      requireHttps?: boolean;
      allowedHosts?: string[];
      allowedRepositories?: string[];
    };
  }) => void;
  invalidateResolvedArtifacts: () => void;
  ensureInitialized: (reason: string) => Promise<void>;
  validateDocument: (document: vscode.TextDocument) => Promise<void>;
  getDiscoveryResult: () => Promise<
    Pick<
      import("../schema/pluginDiscovery").PluginDiscoveryResult,
      "plugins" | "channelSurfaces" | "providerSurfaces" | "status"
    >
  >;
  readSettings: () => ExtensionSettings;
  isInitialized: () => boolean;
  getCatalog: () => Promise<DynamicSubfieldCatalog | null>;
  invalidateCatalog: () => void;
  syncAndRefresh: (force: boolean) => Promise<unknown>;
};

export function registerOpenClawEvents(options: EventRegistrationOptions): void {
  const pendingValidations = new Map<string, NodeJS.Timeout>();

  const scheduleValidation = (document: vscode.TextDocument): void => {
    if (!isOpenClawConfigDocument(document)) {
      return;
    }
    const key = document.uri.toString();
    cancelPendingValidation(pendingValidations, key);
    const timeout = setTimeout(() => {
      pendingValidations.delete(key);
      void options.ensureInitialized("validation").then(() => options.validateDocument(document));
    }, 200);
    pendingValidations.set(key, timeout);
  };

  options.context.subscriptions.push(
    vscode.languages.registerHoverProvider(OPENCLAW_DOCUMENT_SELECTOR, {
      provideHover: async (document, position, token) => {
        if (!isOpenClawConfigDocument(document)) {
          return null;
        }
        if (!options.readSettings().explainOnHover) {
          return null;
        }
        const catalog = await withTimeout(options.getCatalog(), 5_000);
        if (!catalog || token.isCancellationRequested) {
          return null;
        }

        const pathAtCursor = findPathAtOffset(document.getText(), document.offsetAt(position));
        if (pathAtCursor === null) {
          return null;
        }
        const markdown = buildFieldExplainMarkdown(
          pathAtCursor,
          catalog,
          (await withTimeout(options.artifacts.getUiHintsText(), 1_000)) ?? "{}",
          null,
        );
        if (token.isCancellationRequested) {
          return null;
        }

        return new vscode.Hover(new vscode.MarkdownString(markdown));
      },
    }),
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (!isOpenClawConfigDocument(document)) {
        return;
      }
      void options.ensureInitialized("open-document").then(() => options.validateDocument(document));
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      scheduleValidation(event.document);
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      scheduleValidation(document);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      cancelPendingValidation(pendingValidations, document.uri.toString());
      options.jsonLanguageService.clear(document);
      options.runtimeValidator.clear(document);
      options.integratorDiagnostics.clear(document);
      options.pluginDiagnostics.clear(document);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      const settingsChanged =
        event.affectsConfiguration("openclawConfig.sync.manifestUrl") ||
        event.affectsConfiguration("openclawConfig.sync.allowedHosts") ||
        event.affectsConfiguration("openclawConfig.sync.allowedRepositories") ||
        event.affectsConfiguration("openclawConfig.schema.preferredSource") ||
        event.affectsConfiguration("openclawConfig.plugins.commandPath");

      const policyOrCatalogChanged =
        settingsChanged ||
        event.affectsConfiguration("openclawConfig.plugins.metadataUrl") ||
        event.affectsConfiguration("openclawConfig.plugins.metadataLocalPath") ||
        event.affectsConfiguration("openclawConfig.plugins.commandPath");

      const settings = options.readSettings();
      options.runtimeProfiles.invalidate();
      void options.runtimeProfiles.getProfile({
        commandPath: settings.pluginCommandPath,
        workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      }).then((runtime) => {
        options.configureRemote({
          manifestUrl: settings.manifestUrl,
          schemaVersion: settings.schemaVersion !== "latest" ? settings.schemaVersion : runtime.versionTag,
          securityPolicy: {
            requireHttps: true,
            allowedHosts: settings.allowedHosts,
            allowedRepositories: settings.allowedRepositories,
          },
        });
      });

      if (policyOrCatalogChanged) {
        options.invalidateResolvedArtifacts();
        options.invalidateCatalog();
      }

      const validationSettingsChanged =
        event.affectsConfiguration("openclawConfig.integrator.strictSecrets");

      if (validationSettingsChanged && options.isInitialized()) {
        void Promise.all([
          options.runtimeProfiles.getProfile({
            commandPath: settings.pluginCommandPath,
            workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
          }),
          options.getDiscoveryResult(),
        ]).then(([runtime, discovery]) =>
          Promise.all([
            options.jsonLanguageService.revalidateAll(),
            options.runtimeValidator.revalidateAll(runtime),
            options.integratorDiagnostics.revalidateAll({ strictSecrets: settings.strictSecrets }),
            options.pluginDiagnostics.revalidateAll({
              discovery,
            }),
          ]),
        );
      }

      if (settingsChanged && options.isInitialized()) {
        void options.syncAndRefresh(true);
      }
    }),
  );

  options.context.subscriptions.push({
    dispose: () => {
      clearAllPendingValidations(pendingValidations);
    },
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  const timeout = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), timeoutMs);
  });
  return Promise.race([promise, timeout]);
}
