import * as vscode from "vscode";
import { OPENCLAW_SCHEMA_URI } from "./constants";

type SchemaTextProvider = {
  getSchemaText: () => Promise<string>;
};

const KNOWN_SCHEMA_BASENAME = "openclaw.schema.json";

export class OpenClawSchemaContentProvider implements vscode.TextDocumentContentProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(private readonly artifactManager: SchemaTextProvider) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    if (!isOpenClawSchemaUri(uri)) {
      return "{}";
    }
    return this.artifactManager.getSchemaText();
  }

  refresh(): void {
    this.onDidChangeEmitter.fire(vscode.Uri.parse(OPENCLAW_SCHEMA_URI));
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}

function isOpenClawSchemaUri(uri: vscode.Uri): boolean {
  if (uri.scheme !== "openclaw-schema") {
    return false;
  }

  const normalized = uri.path.toLowerCase();
  if (!normalized.includes(KNOWN_SCHEMA_BASENAME)) {
    return false;
  }

  return true;
}
