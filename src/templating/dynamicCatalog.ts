import { buildDynamicSubfieldCatalog, resolveDynamicSubfields } from "../schema/dynamicSubfields";
import type { PluginHintEntry } from "../schema/types";
import type { SectionSnippet } from "./templates";

type UiHintRecord = Record<string, { label?: string; help?: string }>;

export async function buildDynamicSectionSnippets(
  artifacts: {
    getSchemaText: () => Promise<string>;
    getUiHintsText: () => Promise<string>;
  },
  fallbackSnippets: readonly SectionSnippet[],
  pluginEntries: readonly PluginHintEntry[] = [],
): Promise<SectionSnippet[]> {
  try {
    const [schemaText, uiHintsText] = await Promise.all([
      artifacts.getSchemaText(),
      artifacts.getUiHintsText(),
    ]);

    const hints = JSON.parse(uiHintsText) as UiHintRecord;
    const catalog = buildDynamicSubfieldCatalog(schemaText, uiHintsText, pluginEntries);
    const candidates = new Map<string, SectionSnippet>();

    for (const sectionPath of catalog.sections) {
      if (!isSimpleSegment(sectionPath) || sectionPath === "$schema") {
        continue;
      }
      candidates.set(sectionPath, {
        label: sectionPath,
        description: inferDescription(sectionPath, hints[sectionPath]),
        body: buildSnippetBody(sectionPath.split(".")),
      });

      const nested = resolveDynamicSubfields(catalog, sectionPath);
      for (const entry of nested) {
        if (!isSimpleSegment(entry.key)) {
          continue;
        }
        const nestedPath = `${sectionPath}.${entry.key}`;
        if (!isSnippetCandidatePath(nestedPath) || candidates.has(nestedPath)) {
          continue;
        }
        candidates.set(nestedPath, {
          label: nestedPath,
          description: inferDescription(nestedPath, hints[nestedPath]),
          body: buildSnippetBody(nestedPath.split(".")),
        });
      }
    }

    for (const hintPath of Object.keys(hints)) {
      if (!isSnippetCandidatePath(hintPath) || candidates.has(hintPath)) {
        continue;
      }
      candidates.set(hintPath, {
        label: hintPath,
        description: inferDescription(hintPath, hints[hintPath]),
        body: buildSnippetBody(hintPath.split(".")),
      });
    }

    for (const pluginEntry of pluginEntries) {
      const pluginPath = normalizePath(pluginEntry.path);
      if (!isSnippetCandidatePath(pluginPath) || candidates.has(pluginPath)) {
        continue;
      }
      candidates.set(pluginPath, {
        label: pluginPath,
        description: inferDescription(pluginPath, hints[pluginPath]),
        body: buildSnippetBody(pluginPath.split(".")),
      });
    }

    const dynamic = [...candidates.values()].sort((a, b) => a.label.localeCompare(b.label));
    if (dynamic.length === 0) {
      return [...fallbackSnippets];
    }

    const fallbackByLabel = new Set(dynamic.map((item) => item.label));
    const fallbackRemainder = fallbackSnippets.filter((item) => !fallbackByLabel.has(item.label));
    return [...dynamic, ...fallbackRemainder];
  } catch {
    return [...fallbackSnippets];
  }
}

function isSnippetCandidatePath(path: string): boolean {
  if (!path || path === "$schema" || path.includes("*")) {
    return false;
  }
  if (!path.includes(".")) {
    return false;
  }
  const segments = path.split(".");
  if (segments.length > 4) {
    return false;
  }
  return segments.every(isSimpleSegment);
}

function isSimpleSegment(segment: string): boolean {
  return Boolean(segment) && !segment.includes("*") && !segment.includes("[") && !/^\d+$/.test(segment);
}

function inferDescription(path: string, hint?: { label?: string; help?: string }): string {
  if (hint?.help) {
    return hint.help;
  }
  if (hint?.label) {
    return hint.label;
  }
  return `Insert section ${path}`;
}

function buildSnippetBody(segments: string[]): string {
  if (segments.length === 0) {
    return "{}";
  }

  if (segments.length === 1) {
    return `"${segments[0]}": {\n  $1\n}`;
  }

  const first = segments[0];
  const rest = segments.slice(1);
  const nested = buildNestedBody(rest, 1);
  return `"${first}": ${nested}`;
}

function buildNestedBody(segments: string[], depth: number): string {
  const indent = "  ".repeat(depth);
  if (segments.length === 1) {
    return `{\n${indent}"${segments[0]}": {\n${indent}  $1\n${indent}}\n${"  ".repeat(depth - 1)}}`;
  }

  const current = segments[0];
  const tail = buildNestedBody(segments.slice(1), depth + 1);
  return `{\n${indent}"${current}": ${tail}\n${"  ".repeat(depth - 1)}}`;
}

function normalizePath(value: string): string {
  return value
    .trim()
    .replace(/\[(\d+|\*)\]/g, ".$1")
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join(".");
}
