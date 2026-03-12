import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
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
  context: Pick<vscode.ExtensionContext, "globalStorageUri">;
  manifestUrl?: string;
  fetchFn?: typeof fetch;
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
  return isArtifactRecord(artifacts.schema) && isArtifactRecord(artifacts.uiHints);
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
  private manifestUrl: string;
  private securityPolicy: ManifestSecurityPolicy;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly cacheRoot: string;
  private readonly cacheLiveRoot: string;
  private readonly syncStatePath: string;

  constructor(options: ArtifactManagerOptions) {
    this.manifestUrl = normalizeManifestUrl(options.manifestUrl ?? DEFAULT_MANIFEST_URL);
    this.securityPolicy = normalizePolicyInput({
      ...createDefaultPolicy(),
      ...options.securityPolicy,
      allowedHosts: options.securityPolicy?.allowedHosts ?? [...DEFAULT_ALLOWED_HOSTS],
      allowedRepositories:
        options.securityPolicy?.allowedRepositories ?? [...DEFAULT_ALLOWED_REPOSITORIES],
    });
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.cacheRoot = path.join(options.context.globalStorageUri.fsPath, "schema-cache");
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
    void ttlHours;
    await fs.mkdir(this.cacheRoot, { recursive: true });
    await fs.mkdir(this.cacheLiveRoot, { recursive: true });
    return this.ensureCached(false);
  }

  async clearCache(): Promise<void> {
    await fs.rm(this.cacheRoot, { recursive: true, force: true });
  }

  async ensureCached(force: boolean): Promise<SchemaSyncResult> {
    await fs.mkdir(this.cacheRoot, { recursive: true });

    if (!force && (await this.hasCompleteArtifactSet(this.cacheLiveRoot))) {
      return {
        checked: false,
        updated: false,
        source: "cache",
        message: "Using cached schema artifacts.",
      };
    }

    const currentState = await this.readSyncState();
    return this.fetchAndCacheArtifacts(currentState);
  }

  async syncIfNeeded(ttlHours: number, force: boolean): Promise<SchemaSyncResult> {
    void ttlHours;
    return this.ensureCached(force);
  }

  private async fetchAndCacheArtifacts(currentState: SyncState): Promise<SchemaSyncResult> {
    await fs.mkdir(this.cacheRoot, { recursive: true });

    const manifestSecurity = evaluateUrlSecurity(this.manifestUrl, this.securityPolicy);
    if (!manifestSecurity.allowed) {
      const message = `Schema sync blocked by security policy: ${manifestSecurity.reason}`;
      await this.writeSyncState({
        ...currentState,
        lastCheckedAt: new Date(this.now()).toISOString(),
        lastError: message,
      });
      return {
        checked: true,
        updated: false,
        source: await this.getActiveSourceSafe(),
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
      return {
        checked: true,
        updated: false,
        source: await this.getActiveSourceSafe(),
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
      return {
        checked: true,
        updated: false,
        source: await this.getActiveSourceSafe(),
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
      return {
        checked: true,
        updated: false,
        source: await this.getActiveSourceSafe(),
        message: `Schema update rejected: ${toErrorMessage(error)}`,
      };
    }
  }

  async getSchemaText(): Promise<string> {
    const active = await this.resolveActiveRoot();
    return fs.readFile(path.join(active.dir, ARTIFACT_FILE_NAMES.schema), "utf8");
  }

  async getUiHintsText(): Promise<string> {
    const active = await this.resolveActiveRoot();
    return fs.readFile(path.join(active.dir, ARTIFACT_FILE_NAMES.uiHints), "utf8");
  }

  async getActiveSource(): Promise<ArtifactSource> {
    return (await this.resolveActiveRoot()).source;
  }

  async getStatus(): Promise<SchemaStatus> {
    const syncState = await this.readSyncState();
    const active = await this.resolveActiveRoot().catch(() => null);
    const activeManifest = await this.readManifestFromRoot(active?.dir);

    return {
      source: active?.source ?? "missing",
      manifestUrl: this.manifestUrl,
      openclawCommit: activeManifest?.openclawCommit,
      generatedAt: activeManifest?.generatedAt,
      lastCheckedAt: syncState.lastCheckedAt,
      lastSuccessfulSyncAt: syncState.lastSuccessfulSyncAt,
      lastError: syncState.lastError,
      policy: {
        manifest: evaluateUrlSecurity(this.manifestUrl, this.securityPolicy),
        artifacts: activeManifest ? this.evaluateArtifactUrls(activeManifest) : [],
      },
    };
  }

  private evaluateArtifactUrls(manifest: SchemaManifestV1): SecurityEvaluation[] {
    return [
      evaluateUrlSecurity(manifest.artifacts.schema.url, this.securityPolicy),
      evaluateUrlSecurity(manifest.artifacts.uiHints.url, this.securityPolicy),
    ];
  }

  private async downloadAndCommitManifest(manifest: SchemaManifestV1): Promise<void> {
    const [schemaText, uiHintsText] = await Promise.all([
      this.fetchVerifiedArtifact(manifest.artifacts.schema.url, manifest.artifacts.schema.sha256),
      this.fetchVerifiedArtifact(manifest.artifacts.uiHints.url, manifest.artifacts.uiHints.sha256),
    ]);

    const tempDir = path.join(
      this.cacheRoot,
      `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    );

    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(path.join(tempDir, ARTIFACT_FILE_NAMES.schema), schemaText, "utf8");
    await fs.writeFile(path.join(tempDir, ARTIFACT_FILE_NAMES.uiHints), uiHintsText, "utf8");
    await writeJsonFile(path.join(tempDir, ARTIFACT_FILE_NAMES.manifest), manifest);

    await fs.rm(this.cacheLiveRoot, { recursive: true, force: true });
    await fs.rename(tempDir, this.cacheLiveRoot);
  }

  private async fetchVerifiedArtifact(url: string, expectedSha256: string): Promise<string> {
    const content = await fetchText(this.fetchFn, url);
    if (sha256Hex(content) !== expectedSha256) {
      throw new Error(`SHA-256 mismatch for ${url}.`);
    }
    return content;
  }

  private async readCacheManifest(): Promise<SchemaManifestV1 | null> {
    return this.readManifestFromRoot(this.cacheLiveRoot);
  }

  private async readManifestFromRoot(root: string | undefined): Promise<SchemaManifestV1 | null> {
    if (!root) {
      return null;
    }
    const manifestPath = path.join(root, ARTIFACT_FILE_NAMES.manifest);
    if (!(await exists(manifestPath))) {
      return null;
    }
    const parsed = await readJsonFile<unknown>(manifestPath);
    return isSchemaManifestV1(parsed) ? parsed : null;
  }

  private async resolveActiveRoot(): Promise<ActiveRoot> {
    if (await this.hasCompleteArtifactSet(this.cacheLiveRoot)) {
      return { dir: this.cacheLiveRoot, source: "cache" };
    }
    throw new Error("No remote schema cache is available.");
  }

  private async hasCompleteArtifactSet(root: string): Promise<boolean> {
    const required = [
      ARTIFACT_FILE_NAMES.schema,
      ARTIFACT_FILE_NAMES.uiHints,
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

  private async getActiveSourceSafe(): Promise<ArtifactSource> {
    return this.getActiveSource().catch(() => "missing");
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
