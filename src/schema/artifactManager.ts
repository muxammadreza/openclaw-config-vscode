import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type * as vscode from "vscode";
import {
  ARTIFACT_FILE_NAMES,
  DEFAULT_ALLOWED_HOSTS,
  DEFAULT_ALLOWED_REPOSITORIES,
  DEFAULT_MANIFEST_URL,
} from "./constants";
import { evaluateUrlSecurity, normalizePolicyInput } from "./security";
import type {
  ArtifactSource,
  ManifestSecurityPolicy,
  OpenClawZodValidator,
  SchemaManifestV1,
  SchemaStatus,
  SchemaSyncResult,
  SecurityEvaluation,
} from "./types";

type SyncState = {
  lastCheckedAt?: string;
  lastSuccessfulSyncAt?: string;
  lastError?: string;
};

type ArtifactManagerOptions = {
  context: Pick<vscode.ExtensionContext, "extensionPath" | "globalStorageUri">;
  manifestUrl?: string;
  fetchFn?: typeof fetch;
  importModuleFn?: (moduleUrl: string) => Promise<unknown>;
  now?: () => number;
  securityPolicy?: Partial<ManifestSecurityPolicy>;
};

type ActiveRoot = {
  dir: string;
  source: ArtifactSource;
};

const FETCH_TIMEOUT_MS = 10_000;

export function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function isSchemaManifestV1(value: unknown): value is SchemaManifestV1 {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<SchemaManifestV1>;
  if (candidate.version !== 1) {
    return false;
  }
  if (typeof candidate.openclawCommit !== "string" || !candidate.openclawCommit) {
    return false;
  }
  if (typeof candidate.generatedAt !== "string" || !candidate.generatedAt) {
    return false;
  }
  const artifacts = candidate.artifacts;
  if (!artifacts || typeof artifacts !== "object") {
    return false;
  }
  return (
    isArtifactRecord(artifacts.schema) &&
    isArtifactRecord(artifacts.uiHints) &&
    isArtifactRecord(artifacts.validator)
  );
}

function isArtifactRecord(value: unknown): value is SchemaManifestV1["artifacts"]["schema"] {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { url?: unknown; sha256?: unknown };
  return (
    typeof candidate.url === "string" &&
    candidate.url.length > 0 &&
    typeof candidate.sha256 === "string" &&
    candidate.sha256.length === 64
  );
}

async function exists(absolutePath: string): Promise<boolean> {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T>(absolutePath: string): Promise<T> {
  const raw = await fs.readFile(absolutePath, "utf8");
  return JSON.parse(raw) as T;
}

async function writeJsonFile(absolutePath: string, value: unknown): Promise<void> {
  await fs.writeFile(absolutePath, JSON.stringify(value, null, 2), "utf8");
}

async function fetchText(fetchFn: typeof fetch, url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchFn(url, {
      signal: controller.signal,
      headers: {
        "cache-control": "no-cache",
      },
    });
    if (!response.ok) {
      throw new Error(`Fetch failed (${response.status}) for ${url}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function createDefaultPolicy(): ManifestSecurityPolicy {
  return {
    requireHttps: true,
    allowedHosts: [...DEFAULT_ALLOWED_HOSTS],
    allowedRepositories: [...DEFAULT_ALLOWED_REPOSITORIES],
  };
}

export class SchemaArtifactManager {
  private readonly context: Pick<vscode.ExtensionContext, "extensionPath" | "globalStorageUri">;
  private manifestUrl: string;
  private securityPolicy: ManifestSecurityPolicy;
  private readonly fetchFn: typeof fetch;
  private readonly importModuleFn: (moduleUrl: string) => Promise<unknown>;
  private readonly now: () => number;
  private readonly bundledRoot: string;
  private readonly cacheRoot: string;
  private readonly cacheLiveRoot: string;
  private readonly syncStatePath: string;
  private validatorCache: {
    absolutePath: string;
    mtimeMs: number;
    validator: OpenClawZodValidator;
  } | null = null;

  constructor(options: ArtifactManagerOptions) {
    this.context = options.context;
    this.manifestUrl = normalizeManifestUrl(options.manifestUrl ?? DEFAULT_MANIFEST_URL);
    this.securityPolicy = normalizePolicyInput({
      ...createDefaultPolicy(),
      ...options.securityPolicy,
      allowedHosts: options.securityPolicy?.allowedHosts ?? [...DEFAULT_ALLOWED_HOSTS],
      allowedRepositories:
        options.securityPolicy?.allowedRepositories ?? [...DEFAULT_ALLOWED_REPOSITORIES],
    });
    this.fetchFn = options.fetchFn ?? fetch;
    this.importModuleFn = options.importModuleFn ?? importEsmModule;
    this.now = options.now ?? (() => Date.now());
    this.bundledRoot = path.join(this.context.extensionPath, "schemas", "live");
    this.cacheRoot = path.join(this.context.globalStorageUri.fsPath, "schema-cache");
    this.cacheLiveRoot = path.join(this.cacheRoot, "live");
    this.syncStatePath = path.join(this.cacheRoot, "sync-state.json");
  }

  configureRemote(options: {
    manifestUrl?: string;
    schemaVersion?: string;
    securityPolicy?: Partial<ManifestSecurityPolicy>;
  }): void {
    const rawUrl = options.manifestUrl ?? this.manifestUrl;
    this.manifestUrl = normalizeManifestUrl(rawUrl, options.schemaVersion);

    if (options.securityPolicy) {
      const merged: ManifestSecurityPolicy = {
        requireHttps: options.securityPolicy.requireHttps ?? this.securityPolicy.requireHttps,
        allowedHosts: options.securityPolicy.allowedHosts ?? this.securityPolicy.allowedHosts,
        allowedRepositories:
          options.securityPolicy.allowedRepositories ?? this.securityPolicy.allowedRepositories,
      };
      this.securityPolicy = normalizePolicyInput(merged);
    }
  }

  async initialize(ttlHours: number): Promise<SchemaSyncResult> {
    await fs.mkdir(this.cacheRoot, { recursive: true });
    await fs.mkdir(this.cacheLiveRoot, { recursive: true });
    return this.syncIfNeeded(ttlHours, false);
  }

  async syncIfNeeded(ttlHours: number, force: boolean): Promise<SchemaSyncResult> {
    const currentState = await this.readSyncState();
    const ttlMs = Math.max(1, ttlHours) * 60 * 60 * 1000;

    if (!force && currentState.lastCheckedAt) {
      const elapsed = this.now() - Date.parse(currentState.lastCheckedAt);
      if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < ttlMs) {
        const active = await this.resolveActiveRoot();
        return {
          checked: false,
          updated: false,
          source: active.source,
          message: "Skipped schema sync because cache TTL has not expired.",
        };
      }
    }

    const manifestSecurity = evaluateUrlSecurity(this.manifestUrl, this.securityPolicy);
    if (!manifestSecurity.allowed) {
      const message = `Schema sync blocked by security policy: ${manifestSecurity.reason}`;
      await this.writeSyncState({
        ...currentState,
        lastCheckedAt: new Date(this.now()).toISOString(),
        lastError: message,
      });
      const active = await this.resolveActiveRoot();
      return {
        checked: true,
        updated: false,
        source: active.source,
        message,
      };
    }

    let remoteManifest: SchemaManifestV1;
    try {
      const remoteManifestRaw = await fetchText(this.fetchFn, this.manifestUrl);
      const parsed = JSON.parse(remoteManifestRaw) as unknown;
      if (!isSchemaManifestV1(parsed)) {
        throw new Error("Remote manifest has an invalid structure.");
      }
      remoteManifest = parsed;
    } catch (error) {
      await this.writeSyncState({
        ...currentState,
        lastCheckedAt: new Date(this.now()).toISOString(),
        lastError: toErrorMessage(error),
      });
      const active = await this.resolveActiveRoot();
      return {
        checked: true,
        updated: false,
        source: active.source,
        message: `Schema sync failed: ${toErrorMessage(error)}`,
      };
    }

    const artifactEvaluations = this.evaluateArtifactUrls(remoteManifest);
    const blockedArtifact = artifactEvaluations.find((evaluation) => !evaluation.allowed);
    if (blockedArtifact) {
      const message = `Schema sync blocked by artifact policy: ${blockedArtifact.reason}`;
      await this.writeSyncState({
        ...currentState,
        lastCheckedAt: new Date(this.now()).toISOString(),
        lastError: message,
      });
      const active = await this.resolveActiveRoot();
      return {
        checked: true,
        updated: false,
        source: active.source,
        message,
      };
    }

    const currentManifest = await this.readCacheManifest();
    if (
      currentManifest &&
      currentManifest.openclawCommit === remoteManifest.openclawCommit &&
      (await this.hasCompleteArtifactSet(this.cacheLiveRoot))
    ) {
      await this.writeSyncState({
        ...currentState,
        lastCheckedAt: new Date(this.now()).toISOString(),
        lastSuccessfulSyncAt: new Date(this.now()).toISOString(),
        lastError: undefined,
      });
      return {
        checked: true,
        updated: false,
        source: "cache",
        message: "Schema is already up to date.",
      };
    }

    try {
      await this.downloadAndCommitManifest(remoteManifest);
      await this.writeSyncState({
        ...currentState,
        lastCheckedAt: new Date(this.now()).toISOString(),
        lastSuccessfulSyncAt: new Date(this.now()).toISOString(),
        lastError: undefined,
      });
      return {
        checked: true,
        updated: true,
        source: "cache",
        message: `Updated schema artifacts to ${remoteManifest.openclawCommit}.`,
      };
    } catch (error) {
      await this.writeSyncState({
        ...currentState,
        lastCheckedAt: new Date(this.now()).toISOString(),
        lastError: toErrorMessage(error),
      });
      const active = await this.resolveActiveRoot();
      return {
        checked: true,
        updated: false,
        source: active.source,
        message: `Schema update rejected: ${toErrorMessage(error)}`,
      };
    }
  }

  async getSchemaText(): Promise<string> {
    const active = await this.resolveActiveRoot();
    const filePath = path.join(active.dir, ARTIFACT_FILE_NAMES.schema);
    return fs.readFile(filePath, "utf8");
  }

  async getUiHintsText(): Promise<string> {
    const active = await this.resolveActiveRoot();
    const filePath = path.join(active.dir, ARTIFACT_FILE_NAMES.uiHints);
    return fs.readFile(filePath, "utf8");
  }

  async getValidator(): Promise<OpenClawZodValidator | null> {
    const validatorPath = path.join(this.bundledRoot, ARTIFACT_FILE_NAMES.validator);
    if (!(await exists(validatorPath))) {
      return null;
    }

    const stat = await fs.stat(validatorPath);
    if (
      this.validatorCache &&
      this.validatorCache.absolutePath === validatorPath &&
      this.validatorCache.mtimeMs === stat.mtimeMs
    ) {
      return this.validatorCache.validator;
    }

    const importUrl = `${pathToFileURL(validatorPath).href}?v=${stat.mtimeMs}`;
    const loaded = (await this.importModuleFn(importUrl)) as Partial<OpenClawZodValidator>;
    if (typeof loaded.validate !== "function") {
      return null;
    }

    const validator: OpenClawZodValidator = {
      validate: loaded.validate,
    };

    this.validatorCache = {
      absolutePath: validatorPath,
      mtimeMs: stat.mtimeMs,
      validator,
    };

    return validator;
  }

  async getActiveSource(): Promise<ArtifactSource> {
    const active = await this.resolveActiveRoot();
    return active.source;
  }

  async getStatus(): Promise<SchemaStatus> {
    const [syncState, active] = await Promise.all([this.readSyncState(), this.resolveActiveRoot()]);
    const activeManifest = await this.readManifestFromRoot(active.dir);

    const manifestEvaluation = evaluateUrlSecurity(this.manifestUrl, this.securityPolicy);
    const artifactEvaluations = activeManifest
      ? this.evaluateArtifactUrls(activeManifest)
      : [];

    return {
      source: active.source,
      manifestUrl: this.manifestUrl,
      openclawCommit: activeManifest?.openclawCommit,
      generatedAt: activeManifest?.generatedAt,
      lastCheckedAt: syncState.lastCheckedAt,
      lastSuccessfulSyncAt: syncState.lastSuccessfulSyncAt,
      lastError: syncState.lastError,
      policy: {
        manifest: manifestEvaluation,
        artifacts: artifactEvaluations,
      },
    };
  }

  private evaluateArtifactUrls(manifest: SchemaManifestV1): SecurityEvaluation[] {
    return [
      evaluateUrlSecurity(manifest.artifacts.schema.url, this.securityPolicy),
      evaluateUrlSecurity(manifest.artifacts.uiHints.url, this.securityPolicy),
      evaluateUrlSecurity(manifest.artifacts.validator.url, this.securityPolicy),
    ];
  }

  private async downloadAndCommitManifest(manifest: SchemaManifestV1): Promise<void> {
    const downloadedArtifacts = await Promise.all([
      this.fetchVerifiedArtifact(manifest.artifacts.schema.url, manifest.artifacts.schema.sha256),
      this.fetchVerifiedArtifact(manifest.artifacts.uiHints.url, manifest.artifacts.uiHints.sha256),
      this.fetchVerifiedArtifact(manifest.artifacts.validator.url, manifest.artifacts.validator.sha256),
    ]);

    const tempDir = path.join(
      this.cacheRoot,
      `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    );

    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(path.join(tempDir, ARTIFACT_FILE_NAMES.schema), downloadedArtifacts[0], "utf8");
    await fs.writeFile(path.join(tempDir, ARTIFACT_FILE_NAMES.uiHints), downloadedArtifacts[1], "utf8");
    await fs.writeFile(path.join(tempDir, ARTIFACT_FILE_NAMES.validator), downloadedArtifacts[2], "utf8");
    await writeJsonFile(path.join(tempDir, ARTIFACT_FILE_NAMES.manifest), manifest);

    await fs.rm(this.cacheLiveRoot, { recursive: true, force: true });
    await fs.rename(tempDir, this.cacheLiveRoot);
    this.validatorCache = null;
  }

  private async fetchVerifiedArtifact(url: string, expectedSha256: string): Promise<string> {
    const content = await fetchText(this.fetchFn, url);
    const actualHash = sha256Hex(content);
    if (actualHash !== expectedSha256) {
      throw new Error(`SHA-256 mismatch for ${url}.`);
    }
    return content;
  }

  private async readCacheManifest(): Promise<SchemaManifestV1 | null> {
    return this.readManifestFromRoot(this.cacheLiveRoot);
  }

  private async readManifestFromRoot(root: string): Promise<SchemaManifestV1 | null> {
    const manifestPath = path.join(root, ARTIFACT_FILE_NAMES.manifest);
    if (!(await exists(manifestPath))) {
      return null;
    }
    const parsed = await readJsonFile<unknown>(manifestPath);
    if (!isSchemaManifestV1(parsed)) {
      return null;
    }
    return parsed;
  }

  private async resolveActiveRoot(): Promise<ActiveRoot> {
    if (await this.hasCompleteArtifactSet(this.cacheLiveRoot)) {
      return { dir: this.cacheLiveRoot, source: "cache" };
    }
    return { dir: this.bundledRoot, source: "bundled" };
  }

  private async hasCompleteArtifactSet(root: string): Promise<boolean> {
    const required = [
      ARTIFACT_FILE_NAMES.schema,
      ARTIFACT_FILE_NAMES.uiHints,
      ARTIFACT_FILE_NAMES.validator,
      ARTIFACT_FILE_NAMES.manifest,
    ];
    const checks = await Promise.all(required.map((name) => exists(path.join(root, name))));
    return checks.every(Boolean);
  }

  private async readSyncState(): Promise<SyncState> {
    if (!(await exists(this.syncStatePath))) {
      return {};
    }
    try {
      return await readJsonFile<SyncState>(this.syncStatePath);
    } catch {
      return {};
    }
  }

  private async writeSyncState(state: SyncState): Promise<void> {
    await writeJsonFile(this.syncStatePath, state);
  }
}

function normalizeManifestUrl(manifestUrl: string, schemaVersion?: string): string {
  const trimmed = manifestUrl.trim();
  const rawUrl = trimmed || DEFAULT_MANIFEST_URL;
  
  try {
    const parsedUrl = new URL(rawUrl);
    if (schemaVersion && schemaVersion !== "latest") {
      parsedUrl.pathname = parsedUrl.pathname.replace(/\/schemas\/live\//, `/schemas/${schemaVersion}/`);
    }
    return parsedUrl.href;
  } catch {
    return rawUrl;
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

const importEsmModule: (moduleUrl: string) => Promise<unknown> = new Function(
  "moduleUrl",
  "return import(moduleUrl);",
) as (moduleUrl: string) => Promise<unknown>;
