import * as vscode from "vscode";
import {
  appendPath,
  extractBindingIndex,
  extractUnknownKey,
  findPropertyPathFromRange,
  resolvePathFromDiagnosticCode,
} from "./path";
import { looksSensitivePath } from "./secrets";
import { DOCUMENT_SELECTOR, type CodeActionOptions, type OpenClawQuickFixPayload } from "./types";

export class OpenClawCodeActionProvider implements vscode.CodeActionProvider {
  constructor(private readonly options: CodeActionOptions) {}

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    if (!this.options.isEnabled()) {
      return [];
    }

    const actions: vscode.CodeAction[] = [];

    for (const diagnostic of context.diagnostics) {
      const schemaAction = createSetSchemaAction(document, diagnostic);
      if (schemaAction) {
        actions.push(schemaAction);
      }

      const removeUnknownKeyAction = createRemoveUnknownKeyAction(document, diagnostic);
      if (removeUnknownKeyAction) {
        actions.push(removeUnknownKeyAction);
      }

      const dedupeAgentDirAction = createDedupeAgentDirAction(document, diagnostic);
      if (dedupeAgentDirAction) {
        actions.push(dedupeAgentDirAction);
      }

      const removeInvalidBindingAction = createRemoveInvalidBindingAction(document, diagnostic);
      if (removeInvalidBindingAction) {
        actions.push(removeInvalidBindingAction);
      }

      const replaceSecretAction = createSecretEnvRefAction(document, diagnostic);
      if (replaceSecretAction) {
        actions.push(replaceSecretAction);
      }
    }

    return dedupeActions(actions);
  }
}

export function registerOpenClawCodeActions(
  context: vscode.ExtensionContext,
  options: CodeActionOptions,
): void {
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      DOCUMENT_SELECTOR,
      new OpenClawCodeActionProvider(options),
      {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
      },
    ),
  );
}

function createSetSchemaAction(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic,
): vscode.CodeAction | null {
  const message = diagnostic.message.toLowerCase();
  if (!message.includes("$schema")) {
    return null;
  }

  const action = new vscode.CodeAction(
    "Set $schema to OpenClaw schema URI",
    vscode.CodeActionKind.QuickFix,
  );
  action.diagnostics = [diagnostic];
  action.command = {
    command: "openclawConfig.applyQuickFix",
    title: "Apply quick fix",
    arguments: [
      {
        kind: "setSchema",
        uri: document.uri.toString(),
      } satisfies OpenClawQuickFixPayload,
    ],
  };
  action.isPreferred = true;
  return action;
}

function createRemoveUnknownKeyAction(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic,
): vscode.CodeAction | null {
  const unknownKey = extractUnknownKey(diagnostic.message);
  if (!unknownKey) {
    return null;
  }

  let path = resolvePathFromDiagnosticCode(diagnostic.code);
  if (path) {
    path = appendPath(path, unknownKey);
  }

  if (!path) {
    path = findPropertyPathFromRange(document, diagnostic.range);
  }

  if (!path) {
    return null;
  }

  const action = new vscode.CodeAction(
    `Remove unknown key \"${unknownKey}\"`,
    vscode.CodeActionKind.QuickFix,
  );
  action.diagnostics = [diagnostic];
  action.command = {
    command: "openclawConfig.applyQuickFix",
    title: "Apply quick fix",
    arguments: [
      {
        kind: "removeUnknownKey",
        uri: document.uri.toString(),
        path,
      } satisfies OpenClawQuickFixPayload,
    ],
  };
  return action;
}

function createDedupeAgentDirAction(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic,
): vscode.CodeAction | null {
  if (!diagnostic.message.includes("Duplicate agentDir detected")) {
    return null;
  }

  const action = new vscode.CodeAction(
    "Remove duplicate agentDir overrides (keep first)",
    vscode.CodeActionKind.QuickFix,
  );
  action.diagnostics = [diagnostic];
  action.command = {
    command: "openclawConfig.applyQuickFix",
    title: "Apply quick fix",
    arguments: [
      {
        kind: "removeDuplicateAgentDir",
        uri: document.uri.toString(),
        diagnosticMessage: diagnostic.message,
      } satisfies OpenClawQuickFixPayload,
    ],
  };
  return action;
}

function createRemoveInvalidBindingAction(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic,
): vscode.CodeAction | null {
  if (diagnostic.source !== "openclaw-advisory") {
    return null;
  }

  const issuePath = resolvePathFromDiagnosticCode(diagnostic.code);
  if (!issuePath || !issuePath.startsWith("bindings.")) {
    return null;
  }

  const bindingIndex = extractBindingIndex(issuePath);
  if (bindingIndex === null) {
    return null;
  }

  const action = new vscode.CodeAction(
    "Remove invalid binding entry",
    vscode.CodeActionKind.QuickFix,
  );
  action.diagnostics = [diagnostic];
  action.command = {
    command: "openclawConfig.applyQuickFix",
    title: "Apply quick fix",
    arguments: [
      {
        kind: "removeInvalidBinding",
        uri: document.uri.toString(),
        path: `bindings.${bindingIndex}`,
      } satisfies OpenClawQuickFixPayload,
    ],
  };
  return action;
}

function createSecretEnvRefAction(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic,
): vscode.CodeAction | null {
  if (diagnostic.source !== "openclaw-advisory") {
    return null;
  }

  const issuePath = resolvePathFromDiagnosticCode(diagnostic.code);
  if (!issuePath || !looksSensitivePath(issuePath)) {
    return null;
  }

  const action = new vscode.CodeAction(
    "Replace secret with ${env:...}",
    vscode.CodeActionKind.QuickFix,
  );
  action.diagnostics = [diagnostic];
  action.command = {
    command: "openclawConfig.applyQuickFix",
    title: "Apply quick fix",
    arguments: [
      {
        kind: "replaceSecretWithEnvRef",
        uri: document.uri.toString(),
        path: issuePath,
      } satisfies OpenClawQuickFixPayload,
    ],
  };
  action.isPreferred = true;
  return action;
}

function dedupeActions(actions: vscode.CodeAction[]): vscode.CodeAction[] {
  const seen = new Set<string>();
  const next: vscode.CodeAction[] = [];
  for (const action of actions) {
    const key = `${action.title}|${action.command?.command ?? ""}|${JSON.stringify(action.command?.arguments ?? [])}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    next.push(action);
  }
  return next;
}
