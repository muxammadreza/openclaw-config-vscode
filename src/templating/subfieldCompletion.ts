import * as vscode from "vscode";
import { resolveDynamicSubfieldsWithMatches } from "../schema/dynamicSubfields";
import type { DynamicSubfieldCatalog } from "../schema/types";
import { resolveCompletionContext } from "./completion/context";
import { filterHybridDynamicEntries } from "./completion/hybrid";
import { buildKeyCompletionSuggestions, buildValueCompletionSuggestions } from "./completion/items";
import type { CompletionSuggestion } from "./completion/items";
import { isOpenClawConfigDocument } from "../utils";

type CompletionOptions = {
  getCatalog: () => Promise<DynamicSubfieldCatalog | null>;
};

const DOCUMENT_SELECTOR: vscode.DocumentSelector = [
  { language: "jsonc", pattern: "**/openclaw.json" },
  { language: "json", pattern: "**/openclaw.json" },
];

export function registerOpenClawSubfieldCompletion(
  context: vscode.ExtensionContext,
  options: CompletionOptions,
): void {
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      DOCUMENT_SELECTOR,
      new OpenClawSubfieldCompletionProvider(options),
      "\"",
      ":",
    ),
  );
}

class OpenClawSubfieldCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly options: CompletionOptions) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.CompletionItem[]> {
    if (!isOpenClawConfigDocument(document)) {
      return [];
    }

    const catalog = await withTimeout(this.options.getCatalog(), 5_000);
    if (!catalog) {
      return [];
    }

    const text = document.getText();
    const completionContext = resolveCompletionContext(text, document.offsetAt(position));
    if (completionContext.mode === "none") {
      return [];
    }

    if (completionContext.mode === "objectKey") {
      const entries = filterHybridDynamicEntries(
        resolveDynamicSubfieldsWithMatches(catalog, completionContext.objectPath),
      );
      const suggestions = buildKeyCompletionSuggestions(entries, completionContext.existingKeys);
      return suggestions.map((suggestion) => toCompletionItem(suggestion));
    }

    const entries = filterHybridDynamicEntries(
      resolveDynamicSubfieldsWithMatches(catalog, completionContext.objectPath),
    );
    const activeEntry = entries.find((entry) => entry.entry.key === completionContext.propertyKey);
    if (!activeEntry) {
      return [];
    }

    const suggestions = buildValueCompletionSuggestions(activeEntry);
    return suggestions.map((suggestion) => toCompletionItem(suggestion));
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  const timeout = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), timeoutMs);
  });
  return Promise.race([promise, timeout]);
}

function toCompletionItem(suggestion: CompletionSuggestion): vscode.CompletionItem {
  const kind =
    suggestion.kind === "property" ? vscode.CompletionItemKind.Property : vscode.CompletionItemKind.Value;
  const item = new vscode.CompletionItem(suggestion.label, kind);
  item.detail = suggestion.detail;
  item.documentation = suggestion.documentation
    ? new vscode.MarkdownString(suggestion.documentation)
    : undefined;
  item.filterText = suggestion.filterText;
  item.sortText = suggestion.sortText;
  item.insertText =
    suggestion.insertText.kind === "snippet"
      ? new vscode.SnippetString(suggestion.insertText.value)
      : suggestion.insertText.value;
  return item;
}
