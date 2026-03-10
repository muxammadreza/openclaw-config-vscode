import * as vscode from "vscode";
import {
  CompletionItemKind as LspCompletionItemKind,
  DiagnosticSeverity as LspDiagnosticSeverity,
  getLanguageService,
  type JSONDocument,
  type CompletionList as LspCompletionList,
  type Hover as LspHover,
  type MarkedString,
  type MarkupContent,
} from "vscode-json-languageservice";
import { TextDocument } from "vscode-languageserver-textdocument";
import { OPENCLAW_DOCUMENT_SELECTOR } from "../extension/documentSelector";
import { isOpenClawConfigDocument } from "../utils";

type ResolvedSchemaReader = {
  getSchemaText: () => Promise<string>;
};

type JsonLanguageServiceOptions = {
  artifacts: ResolvedSchemaReader;
  output: Pick<{ appendLine(value: string): void }, "appendLine">;
};

const RESOLVED_SCHEMA_URI = "openclaw-resolved://schema/openclaw.schema.json";

export class OpenClawJsonLanguageService implements vscode.Disposable {
  private readonly diagnostics = vscode.languages.createDiagnosticCollection("openclaw-json");
  private readonly languageService = getLanguageService({});
  private schemaCache: Promise<Record<string, unknown>> | null = null;

  constructor(private readonly options: JsonLanguageServiceOptions) {}

  dispose(): void {
    this.diagnostics.dispose();
  }

  invalidateSchema(): void {
    this.schemaCache = null;
  }

  clear(document: vscode.TextDocument): void {
    this.diagnostics.delete(document.uri);
  }

  async validateDocument(document: vscode.TextDocument): Promise<void> {
    if (!isOpenClawConfigDocument(document)) {
      this.clear(document);
      return;
    }

    const versionAtStart = document.version;
    const context = await this.createContext(document);
    if (!context) {
      this.clear(document);
      return;
    }

    const diagnostics = await this.languageService.doValidation(context.document, context.jsonDocument, {
      comments: "ignore",
      trailingCommas: "ignore",
      schemaValidation: "error",
      schemaRequest: "ignore",
    });

    if (document.version !== versionAtStart) {
      return;
    }

    this.diagnostics.set(document.uri, diagnostics.map(toVsCodeDiagnostic));
  }

  async revalidateAll(): Promise<void> {
    const targets = vscode.workspace.textDocuments.filter((document) =>
      isOpenClawConfigDocument(document),
    );
    await Promise.all(targets.map((document) => this.validateDocument(document)));
  }

  registerProviders(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      this.diagnostics,
      vscode.languages.registerCompletionItemProvider(
        OPENCLAW_DOCUMENT_SELECTOR,
        {
          provideCompletionItems: async (document, position) => {
            const languageContext = await this.createContext(document);
            if (!languageContext) {
              return null;
            }
            const completion = await this.languageService.doComplete(
              languageContext.document,
              position,
              languageContext.jsonDocument,
            );
            if (!completion) {
              return null;
            }
            return toVsCodeCompletionList(completion);
          },
        },
        "\"",
        ":",
        ",",
      ),
      vscode.languages.registerHoverProvider(OPENCLAW_DOCUMENT_SELECTOR, {
        provideHover: async (document, position) => {
          const languageContext = await this.createContext(document);
          if (!languageContext) {
            return null;
          }
          const hover = await this.languageService.doHover(
            languageContext.document,
            position,
            languageContext.jsonDocument,
          );
          return hover ? toVsCodeHover(hover) : null;
        },
      }),
    );
  }

  private async createContext(document: vscode.TextDocument): Promise<{
    document: TextDocument;
    jsonDocument: JSONDocument;
  } | null> {
    try {
      const schema = await this.getSchemaObject();
      this.languageService.configure({
        allowComments: true,
        schemas: [
          {
            uri: RESOLVED_SCHEMA_URI,
            fileMatch: ["*"],
            schema,
          },
        ],
      });
      const textDocument = TextDocument.create(
        document.uri.toString(),
        document.languageId || "jsonc",
        document.version,
        document.getText(),
      );
      return {
        document: textDocument,
        jsonDocument: this.languageService.parseJSONDocument(textDocument),
      };
    } catch (error) {
      this.options.output.appendLine(
        `[json-ls] Failed to prepare JSON language service: ${toErrorMessage(error)}`,
      );
      return null;
    }
  }

  private async getSchemaObject(): Promise<Record<string, unknown>> {
    if (!this.schemaCache) {
      this.schemaCache = this.loadSchemaObject();
    }
    return this.schemaCache;
  }

  private async loadSchemaObject(): Promise<Record<string, unknown>> {
    const schemaText = await this.options.artifacts.getSchemaText();
    const parsed = JSON.parse(schemaText) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Resolved schema is not a JSON object.");
    }
    return parsed as Record<string, unknown>;
  }
}

function toVsCodeDiagnostic(
  diagnostic: {
    range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
    message: string;
    severity?: number;
    code?: string | number;
  },
): vscode.Diagnostic {
  const next = new vscode.Diagnostic(
    new vscode.Range(
      diagnostic.range.start.line,
      diagnostic.range.start.character,
      diagnostic.range.end.line,
      diagnostic.range.end.character,
    ),
    diagnostic.message,
    mapDiagnosticSeverity(diagnostic.severity),
  );
  next.source = "openclaw-json";
  next.code = diagnostic.code;
  return next;
}

function mapDiagnosticSeverity(severity?: number): vscode.DiagnosticSeverity {
  switch (severity) {
    case LspDiagnosticSeverity.Warning:
      return vscode.DiagnosticSeverity.Warning;
    case LspDiagnosticSeverity.Information:
      return vscode.DiagnosticSeverity.Information;
    case LspDiagnosticSeverity.Hint:
      return vscode.DiagnosticSeverity.Hint;
    case LspDiagnosticSeverity.Error:
    default:
      return vscode.DiagnosticSeverity.Error;
  }
}

function toVsCodeCompletionList(list: LspCompletionList): vscode.CompletionList {
  const items = list.items.map((entry) => {
    const item = new vscode.CompletionItem(entry.label, mapCompletionKind(entry.kind));
    item.detail = entry.detail;
    item.documentation = toDocumentation(entry.documentation);
    item.sortText = entry.sortText;
    item.filterText = entry.filterText;
    item.preselect = entry.preselect;
    item.commitCharacters = entry.commitCharacters;

    const textEdit = entry.textEdit;
    if (textEdit) {
      const range = "range" in textEdit ? textEdit.range : textEdit.insert;
      item.range = new vscode.Range(
        range.start.line,
        range.start.character,
        range.end.line,
        range.end.character,
      );
      item.insertText =
        entry.insertTextFormat === 2
          ? new vscode.SnippetString(textEdit.newText)
          : textEdit.newText;
    } else if (entry.insertText) {
      item.insertText =
        entry.insertTextFormat === 2
          ? new vscode.SnippetString(entry.insertText)
          : entry.insertText;
    }

    return item;
  });

  return new vscode.CompletionList(items, list.isIncomplete);
}

function mapCompletionKind(kind?: number): vscode.CompletionItemKind {
  switch (kind) {
    case LspCompletionItemKind.Property:
      return vscode.CompletionItemKind.Property;
    case LspCompletionItemKind.Value:
      return vscode.CompletionItemKind.Value;
    case LspCompletionItemKind.Enum:
      return vscode.CompletionItemKind.Enum;
    case LspCompletionItemKind.EnumMember:
      return vscode.CompletionItemKind.EnumMember;
    case LspCompletionItemKind.Constant:
      return vscode.CompletionItemKind.Constant;
    case LspCompletionItemKind.Keyword:
      return vscode.CompletionItemKind.Keyword;
    case LspCompletionItemKind.Module:
      return vscode.CompletionItemKind.Module;
    case LspCompletionItemKind.Class:
      return vscode.CompletionItemKind.Class;
    case LspCompletionItemKind.Field:
      return vscode.CompletionItemKind.Field;
    default:
      return vscode.CompletionItemKind.Text;
  }
}

function toVsCodeHover(hover: LspHover): vscode.Hover {
  const contents = normalizeHoverContents(hover.contents);
  const markdown = new vscode.MarkdownString(
    contents
      .map((entry) => {
        if (typeof entry === "string") {
          return entry;
        }
        if (isMarkupContent(entry)) {
          return entry.kind === "markdown" ? entry.value : `\`\`\`\n${entry.value}\n\`\`\``;
        }
        if (isMarkedCodeBlock(entry)) {
          return `\`\`\`${entry.language}\n${entry.value}\n\`\`\``;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n\n"),
  );

  if (hover.range) {
    return new vscode.Hover(
      markdown,
      new vscode.Range(
        hover.range.start.line,
        hover.range.start.character,
        hover.range.end.line,
        hover.range.end.character,
      ),
    );
  }

  return new vscode.Hover(markdown);
}

function toDocumentation(value: unknown): vscode.MarkdownString | string | undefined {
  if (!value) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && "value" in (value as { value?: unknown })) {
    const typed = value as { kind?: string; value: string };
    const markdown = new vscode.MarkdownString(
      typed.kind === "markdown" ? typed.value : `\`\`\`\n${typed.value}\n\`\`\``,
    );
    return markdown;
  }
  return undefined;
}

function normalizeHoverContents(
  contents: LspHover["contents"],
): Array<string | MarkedString | MarkupContent> {
  return Array.isArray(contents) ? contents : [contents];
}

function isMarkupContent(value: MarkedString | MarkupContent): value is MarkupContent {
  return typeof value === "object" && "kind" in value;
}

function isMarkedCodeBlock(
  value: MarkedString | MarkupContent,
): value is { language: string; value: string } {
  return typeof value === "object" && "language" in value;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
