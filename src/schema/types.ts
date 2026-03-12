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
  };
};

export type ArtifactSource = "cache" | "missing";

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

export type DiscoveryConfidence = "explicit" | "derived" | "inferred";

export type DiscoveredSurfaceSource =
  | "cli"
  | "manifest"
  | "gateway-rpc"
  | "bundled-sdk"
  | "code-ast";

export type SchemaResolutionSource = "gateway-rpc" | "remote-versioned";

export type SchemaPreferredSource = "auto" | "gateway" | "remote";

export type SchemaCapabilities = {
  gatewaySchema: boolean;
  gatewaySchemaLookup: boolean;
  runtimeValidateJson: boolean;
  pluginListJson: boolean;
  remoteVersionedFallback: boolean;
};

export type DiscoveredPlugin = {
  id: string;
  version?: string;
  name?: string;
  description?: string;
  kind?: string;
  enabled?: boolean;
  status?: string;
  source?: string;
  origin?: string;
  manifestPath?: string;
  pluginRoot?: string;
  declaredChannels?: string[];
  declaredProviders?: string[];
  declaredSkills?: string[];
  configJsonSchema?: Record<string, unknown>;
  configUiHints?: Record<string, Record<string, unknown>>;
};

export type DiscoveredConfigSurface = {
  id: string;
  path: string;
  schema?: Record<string, unknown>;
  uiHints?: Record<string, Record<string, unknown>>;
  assistivePaths?: string[];
  source: DiscoveredSurfaceSource;
  confidence: DiscoveryConfidence;
  originPluginId: string;
  label?: string;
  description?: string;
};

export type DiscoveredPluginSurface = DiscoveredConfigSurface & {
  kind: "plugin";
};

export type DiscoveredChannelSurface = DiscoveredConfigSurface & {
  kind: "channel";
};

export type DiscoveredProviderSurface = DiscoveredConfigSurface & {
  kind: "provider";
};

export type PluginDiscoveryStatus = {
  source: PluginDiscoverySource;
  commandPath: string;
  pluginCount: number;
  channelCount: number;
  providerCount: number;
  schemaBackedSurfaceCount: number;
  assistiveOnlySurfaceCount: number;
  confidence: Record<DiscoveryConfidence, number>;
  authoritative: boolean;
  warnings: string[];
  lastError?: string;
};

export type LocalRuntimeProfile = {
  commandPath: string;
  workspaceRoot?: string;
  available: boolean;
  version?: string;
  versionTag?: string;
  configPath?: string;
  validatorSupportsJson: boolean;
  lastError?: string;
};

export type ResolvedSchemaInfo = {
  requestedVersion: string;
  resolvedVersion?: string;
  source: SchemaResolutionSource;
  versionMatched: boolean;
  openclawCommit?: string;
  generatedAt?: string;
  warnings: string[];
  capabilities: SchemaCapabilities;
};

export type ResolvedSchemaStatus = {
  artifacts: SchemaStatus;
  pluginDiscovery: PluginDiscoveryStatus;
  runtime: LocalRuntimeProfile;
  resolvedSchema: ResolvedSchemaInfo;
};

export type SchemaLookupChild = {
  key: string;
  path: string;
  type?: string | string[];
  required?: boolean;
  hasChildren?: boolean;
  hint?: {
    label?: string;
    help?: string;
  };
  hintPath?: string;
};

export type SchemaLookupResult = {
  path: string;
  schema: Record<string, unknown>;
  hint?: {
    label?: string;
    help?: string;
  };
  hintPath?: string;
  children: SchemaLookupChild[];
};

export type ResolvedRuntimeSchemaSnapshot = {
  schemaText: string;
  uiHintsText: string;
  openclawVersion?: string;
  openclawCommit?: string;
  generatedAt?: string;
  source: SchemaResolutionSource;
  capabilities: SchemaCapabilities;
  warnings: string[];
};

export type ResolvedSnapshotMetadata = {
  cacheKey: string;
  pluginFingerprint: string;
  sourceIdentity: string;
  storedAt: string;
};

export type PersistedResolvedRuntimeSchemaSnapshot = {
  metadata: ResolvedSnapshotMetadata;
  snapshot: ResolvedRuntimeSchemaSnapshot;
  discovery: {
    plugins: DiscoveredPlugin[];
    pluginSurfaces: DiscoveredPluginSurface[];
    channelSurfaces: DiscoveredChannelSurface[];
    providerSurfaces: DiscoveredProviderSurface[];
    status: PluginDiscoveryStatus;
  };
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
  | "plugin-disabled-config"
  | "channel-entry-missing";

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
