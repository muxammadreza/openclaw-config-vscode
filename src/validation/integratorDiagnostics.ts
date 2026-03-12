import * as vscode from "vscode";
import { parse, type ParseError } from "jsonc-parser";
import { isOpenClawConfigDocument } from "../utils";
import { findDiagnosticRange } from "./pathRanges";
import { evaluateIntegratorIssues } from "./integratorRules";

export type IntegratorDiagnosticsOptions = {
  strictSecrets: boolean;
};

export class OpenClawIntegratorDiagnostics {
  private readonly diagnostics = vscode.languages.createDiagnosticCollection("openclaw-advisory");

  dispose(): void {
    this.diagnostics.dispose();
  }

  clear(document: vscode.TextDocument): void {
    this.diagnostics.delete(document.uri);
  }

  async validateDocument(
    document: vscode.TextDocument,
    options: IntegratorDiagnosticsOptions,
  ): Promise<void> {
    if (!isOpenClawConfigDocument(document)) {
      this.clear(document);
      return;
    }

    const parseErrors: ParseError[] = [];
    const parsed = parse(document.getText(), parseErrors, {
      allowTrailingComma: true,
      disallowComments: false,
      allowEmptyContent: true,
    });

    if (parseErrors.length > 0) {
      this.clear(document);
      return;
    }

    const issues = evaluateIntegratorIssues(parsed, {
      strictSecrets: options.strictSecrets,
    });

    const diagnostics = issues.map((issue) => {
      const diagnostic = new vscode.Diagnostic(
        findDiagnosticRange(document, issue.path),
        issue.message,
        issue.severity === "error"
          ? vscode.DiagnosticSeverity.Error
          : vscode.DiagnosticSeverity.Warning,
      );
      diagnostic.source = "openclaw-advisory";
      diagnostic.code = issue.path || issue.code;
      return diagnostic;
    });

    this.diagnostics.set(document.uri, diagnostics);
  }

  async revalidateAll(options: IntegratorDiagnosticsOptions): Promise<void> {
    const targets = vscode.workspace.textDocuments.filter((document) =>
      isOpenClawConfigDocument(document),
    );
    await Promise.all(targets.map((document) => this.validateDocument(document, options)));
  }
}
