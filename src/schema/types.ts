export type SchemaArtifactRecord = {
  url: string;
  sha256: string;
};

export type ManifestSecurityPolicy = {
  requireHttps: boolean;
  allowedHosts: string[];
  allowedRepositories: string[];
};

export type SchemaManifestV1 = {
  version: 1;
  openclawCommit: string;
  generatedAt: string;
  artifacts: {
    schema: SchemaArtifactRecord;
    uiHints: SchemaArtifactRecord;
    validator: SchemaArtifactRecord;
  };
};

export type OpenClawValidationIssue = {
  path: string;
  message: string;
};

export type OpenClawZodValidator = {
  validate: (raw: unknown) => OpenClawValidationIssue[];
};

export type ArtifactSource = "cache" | "bundled";

export type SchemaSyncResult = {
  checked: boolean;
  updated: boolean;
  source: ArtifactSource;
  message: string;
};

export type SecurityEvaluation = {
  allowed: boolean;
  reason: string;
  host?: string;
  repository?: string;
};

export type SchemaStatus = {
  source: ArtifactSource;
  manifestUrl: string;
  openclawCommit?: string;
  generatedAt?: string;
  lastCheckedAt?: string;
  lastSuccessfulSyncAt?: string;
  lastError?: string;
  policy: {
    manifest: SecurityEvaluation;
    artifacts: SecurityEvaluation[];
  };
};

export type PluginDiscoverySource = "cli" | "manifest-fallback" | "unavailable";

export type DiscoveredPlugin = {
  id: string;
  name?: string;
  description?: string;
  kind?: string;
  enabled?: boolean;
  status?: string;
  source?: string;
  origin?: string;
  configJsonSchema?: Record<string, unknown>;
  configUiHints?: Record<string, Record<string, unknown>>;
};

export type PluginDiscoveryStatus = {
  source: PluginDiscoverySource;
  commandPath: string;
  pluginCount: number;
  lastError?: string;
};

export type ResolvedSchemaStatus = {
  artifacts: SchemaStatus;
  pluginDiscovery: PluginDiscoveryStatus;
};

export type DiagnosticFingerprint = string;

export type IntegratorIssueSeverity = "warning" | "error";

export type IntegratorIssueCode =
  | "binding-agent-missing"
  | "binding-account-missing"
  | "secret-hygiene";

export type IntegratorIssue = {
  code: IntegratorIssueCode;
  path: string;
  message: string;
  severity: IntegratorIssueSeverity;
};

export type PluginValidationIssueSeverity = "warning" | "error";

export type PluginValidationIssueCode =
  | "plugin-entry-missing"
  | "plugin-allow-missing"
  | "plugin-deny-missing"
  | "plugin-slot-memory-missing"
  | "plugin-slot-context-engine-missing"
  | "plugin-disabled-config";

export type PluginValidationIssue = {
  code: PluginValidationIssueCode;
  path: string;
  message: string;
  severity: PluginValidationIssueSeverity;
};

export type CompletionPrimitive = string | number | boolean | null;

export type DynamicValueType = "string" | "number" | "integer" | "boolean" | "object" | "array";

export type DynamicValueHints = {
  valueType?: DynamicValueType;
  enumValues?: CompletionPrimitive[];
  examples?: CompletionPrimitive[];
  defaultValue?: CompletionPrimitive;
};

export type DynamicSubfieldEntry = {
  key: string;
  path: string;
  description?: string;
  source: "schema" | "plugin";
  snippet?: string;
  valueHints?: DynamicValueHints;
};

export type DynamicSubfieldCatalog = {
  sections: string[];
  fieldsByPattern: Map<string, DynamicSubfieldEntry[]>;
};

export type ResolvedDynamicSubfieldEntry = {
  entry: DynamicSubfieldEntry;
  matchedPattern: string;
  matchedByWildcard: boolean;
};

export type PluginHintProperty = {
  description?: string;
  snippet?: string;
  type?: string;
  enumValues?: CompletionPrimitive[];
  examples?: CompletionPrimitive[];
  defaultValue?: CompletionPrimitive;
};

export type PluginHintEntry = {
  path: string;
  properties: Record<string, PluginHintProperty>;
};

export type PluginHintDocumentV1 = {
  version: 1;
  entries: PluginHintEntry[];
};
