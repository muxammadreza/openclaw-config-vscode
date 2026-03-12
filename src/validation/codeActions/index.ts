export { OpenClawCodeActionProvider, registerOpenClawCodeActions } from "./provider";
export { applyQuickFix } from "./transform";
export { computeQuickFixText, isQuickFixPayload, resolveDuplicateAgentDirPaths } from "./text";
export {
  appendPath,
  extractBindingIndex,
  extractUnknownKey,
  findPropertyPathFromRange,
  fullDocumentRange,
  pathExistsInDocument,
  resolvePathFromDiagnosticCode,
} from "./path";
export { looksSensitivePath, toEnvVarName } from "./secrets";
export type { CodeActionOptions, OpenClawQuickFixPayload, QuickFixKind } from "./types";
