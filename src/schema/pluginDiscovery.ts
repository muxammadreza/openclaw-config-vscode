import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "jsonc-parser";
import { promisify } from "node:util";
import type { DiscoveredPlugin, PluginDiscoveryStatus } from "./types";

const execFile = promisify(execFileCallback);
const DEFAULT_DISCOVERY_TIMEOUT_MS = 8_000;

type CliPluginListPayload = {
  plugins?: unknown[];
};

export type PluginDiscoveryOptions = {
  commandPath: string;
  workspaceRoot?: string;
  timeoutMs?: number;
};

export type PluginDiscoveryResult = {
  plugins: DiscoveredPlugin[];
  status: PluginDiscoveryStatus;
};

export async function discoverInstalledPlugins(
  options: PluginDiscoveryOptions,
): Promise<PluginDiscoveryResult> {
  const commandPath = options.commandPath.trim() || "openclaw";

  try {
    const cliResult = await discoverViaCli({
      ...options,
      commandPath,
    });
    return {
      plugins: cliResult,
      status: {
        source: "cli",
        commandPath,
        pluginCount: cliResult.length,
      },
    };
  } catch (error) {
    const fallback = await discoverViaManifestFallback();
    if (fallback.length > 0) {
      return {
        plugins: fallback,
        status: {
          source: "manifest-fallback",
          commandPath,
          pluginCount: fallback.length,
          lastError: toErrorMessage(error),
        },
      };
    }

    return {
      plugins: [],
      status: {
        source: "unavailable",
        commandPath,
        pluginCount: 0,
        lastError: toErrorMessage(error),
      },
    };
  }
}

async function discoverViaCli(options: PluginDiscoveryOptions): Promise<DiscoveredPlugin[]> {
  const { stdout } = await execFile(
    options.commandPath,
    ["plugins", "list", "--json"],
    {
      cwd: options.workspaceRoot,
      encoding: "utf8",
      timeout: options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    },
  );

  return parseCliPluginListRaw(stdout);
}

async function discoverViaManifestFallback(): Promise<DiscoveredPlugin[]> {
  const manifests = new Map<string, DiscoveredPlugin>();

  for (const candidatePath of await collectManifestCandidatePaths()) {
    const plugin = await readManifestPlugin(candidatePath).catch(() => null);
    if (!plugin) {
      continue;
    }
    manifests.set(plugin.id, plugin);
  }

  return [...manifests.values()].sort((left, right) => left.id.localeCompare(right.id));
}

async function collectManifestCandidatePaths(): Promise<string[]> {
  const pluginDirs = new Set<string>();
  const homeRoot = path.join(os.homedir(), ".openclaw");
  const configPath = path.join(homeRoot, "openclaw.json");
  const parsedConfig = await readJsoncFile<Record<string, unknown>>(configPath);
  const pluginsConfig = asRecord(parsedConfig?.plugins);

  const loadPaths = asRecord(pluginsConfig?.load);
  const configuredPaths = asStringArray(loadPaths?.paths);
  for (const configuredPath of configuredPaths) {
    pluginDirs.add(resolvePluginRoot(configuredPath));
  }

  const installs = asRecord(pluginsConfig?.installs);
  for (const installRecord of Object.values(installs ?? {})) {
    const typedRecord = asRecord(installRecord);
    const installPath = getOptionalString(typedRecord?.installPath);
    if (installPath) {
      pluginDirs.add(resolvePluginRoot(installPath));
    }
    const sourcePath = getOptionalString(typedRecord?.sourcePath);
    if (sourcePath) {
      pluginDirs.add(resolvePluginRoot(sourcePath));
    }
  }

  const globalExtensionsRoot = path.join(homeRoot, "extensions");
  for (const child of await readdirSafe(globalExtensionsRoot)) {
    pluginDirs.add(resolvePluginRoot(path.join(globalExtensionsRoot, child)));
  }

  return [...pluginDirs]
    .map((pluginDir) => path.join(pluginDir, "openclaw.plugin.json"))
    .sort((left, right) => left.localeCompare(right));
}

async function readManifestPlugin(manifestPath: string): Promise<DiscoveredPlugin | null> {
  const raw = await fs.readFile(manifestPath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const id = getOptionalString(parsed.id);
  const configJsonSchema = asRecord(parsed.configSchema);
  if (!id || !configJsonSchema) {
    return null;
  }

  return {
    id,
    name: getOptionalString(parsed.name) ?? undefined,
    description: getOptionalString(parsed.description) ?? undefined,
    kind: getOptionalString(parsed.kind) ?? undefined,
    configJsonSchema,
    configUiHints: normalizeUiHints(parsed.uiHints),
  };
}

function normalizeCliPlugin(value: unknown): DiscoveredPlugin | null {
  const plugin = asRecord(value);
  if (!plugin) {
    return null;
  }
  const id = getOptionalString(plugin?.id);
  if (!id) {
    return null;
  }

  return {
    id,
    name: getOptionalString(plugin["name"]) ?? undefined,
    description: getOptionalString(plugin["description"]) ?? undefined,
    kind: getOptionalString(plugin["kind"]) ?? undefined,
    enabled: typeof plugin["enabled"] === "boolean" ? plugin["enabled"] : undefined,
    status: getOptionalString(plugin["status"]) ?? undefined,
    source: getOptionalString(plugin["source"]) ?? undefined,
    origin: getOptionalString(plugin["origin"]) ?? undefined,
    configJsonSchema: asRecord(plugin["configJsonSchema"]) ?? undefined,
    configUiHints: normalizeUiHints(plugin["configUiHints"]),
  };
}

function normalizeUiHints(value: unknown): Record<string, Record<string, unknown>> | undefined {
  const hints = asRecord(value);
  if (!hints) {
    return undefined;
  }

  const normalized = Object.fromEntries(
    Object.entries(hints)
      .map(([hintPath, hintValue]) => [hintPath.trim(), asRecord(hintValue)])
      .filter(
        (entry): entry is [string, Record<string, unknown>] =>
          Boolean(entry[0]) && Boolean(entry[1]),
      ),
  );

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function parseCliPluginListRaw(raw: string): DiscoveredPlugin[] {
  const parsed = extractJsonPayload(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Local plugin discovery returned invalid JSON.");
  }

  const payload = parsed as CliPluginListPayload;
  if (!Array.isArray(payload.plugins)) {
    throw new Error("Local plugin discovery payload is missing plugins[].");
  }

  return payload.plugins
    .map((plugin) => normalizeCliPlugin(plugin))
    .filter((plugin): plugin is DiscoveredPlugin => plugin !== null)
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function extractJsonPayload(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const candidates = [...trimmed.matchAll(/[{\[]/g)].map((match) => match.index ?? -1);
  for (const startIndex of candidates) {
    if (startIndex < 0) {
      continue;
    }
    const candidate = trimmed.slice(startIndex);
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      continue;
    }
  }

  return null;
}

async function readJsoncFile<T>(absolutePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(absolutePath, "utf8");
    return parse(raw) as T;
  } catch {
    return null;
  }
}

async function readdirSafe(absolutePath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(absolutePath);
    return entries;
  } catch {
    return [];
  }
}

function resolvePluginRoot(inputPath: string): string {
  const expandedPath = inputPath.startsWith("~")
    ? path.join(os.homedir(), inputPath.slice(1))
    : inputPath;
  return path.extname(expandedPath) ? path.dirname(expandedPath) : expandedPath;
}

function getOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((entry) => getOptionalString(entry))
        .filter((entry): entry is string => Boolean(entry))
    : [];
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
