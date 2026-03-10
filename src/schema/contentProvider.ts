import * as vscode from "vscode";
import { OPENCLAW_SCHEMA_URI } from "./constants";

const KNOWN_SCHEMA_BASENAME = "openclaw.schema.json";
const COMPATIBILITY_SCHEMA = JSON.stringify(
  {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: true,
  },
  null,
  2,
);

export class OpenClawSchemaContentProvider implements vscode.TextDocumentContentProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    if (!isOpenClawSchemaUri(uri)) {
      return "{}";
    }
    return COMPATIBILITY_SCHEMA;
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
