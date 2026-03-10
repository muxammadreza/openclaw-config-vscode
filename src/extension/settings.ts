import * as vscode from "vscode";
import {
  DEFAULT_ALLOWED_HOSTS,
  DEFAULT_ALLOWED_REPOSITORIES,
  DEFAULT_MANIFEST_URL,
} from "../schema/constants";
import { clampTtlHours } from "../utils";

export type ExtensionSettings = {
  ttlHours: number;
  zodShadowEnabled: boolean;
  strictSecrets: boolean;
  explainOnHover: boolean;
  manifestUrl: string;
  allowedHosts: string[];
  allowedRepositories: string[];
  pluginMetadataUrl: string;
  pluginMetadataLocalPath: string;
  codeActionsEnabled: boolean;
  schemaVersion: string;
  autoUpdate: boolean;
};

export function readSettings(): ExtensionSettings {
  const config = vscode.workspace.getConfiguration("openclawConfig");

  const ttlHours = clampTtlHours(config.get<number>("sync.ttlHours", 6));
  const zodShadowEnabled = config.get<boolean>("zodShadow.enabled", true);
  const strictSecrets = config.get<boolean>("integrator.strictSecrets", false);
  const explainOnHover = config.get<boolean>("integrator.explainOnHover", true);
  const manifestUrl =
    (config.get<string>("sync.manifestUrl", DEFAULT_MANIFEST_URL) || DEFAULT_MANIFEST_URL).trim();

  const allowedHosts = normalizeStringArray(
    config.get<string[]>("sync.allowedHosts", [...DEFAULT_ALLOWED_HOSTS]),
    [...DEFAULT_ALLOWED_HOSTS],
  );
  const allowedRepositories = normalizeStringArray(
    config.get<string[]>("sync.allowedRepositories", [...DEFAULT_ALLOWED_REPOSITORIES]),
    [...DEFAULT_ALLOWED_REPOSITORIES],
  );

  const pluginMetadataUrl = (config.get<string>("plugins.metadataUrl", "") || "").trim();
  const pluginMetadataLocalPath =
    (config.get<string>("plugins.metadataLocalPath", ".openclaw/plugin-hints.json") ||
      ".openclaw/plugin-hints.json")
      .trim();

  const codeActionsEnabled = config.get<boolean>("codeActions.enabled", true);
  
  const schemaVersion = config.get<string>("sync.schemaVersion", "latest").trim();
  const autoUpdate = config.get<boolean>("updates.autoUpdate", true);

  return {
    ttlHours,
    zodShadowEnabled,
    strictSecrets,
    explainOnHover,
    manifestUrl,
    allowedHosts,
    allowedRepositories,
    pluginMetadataUrl,
    pluginMetadataLocalPath,
    codeActionsEnabled,
    schemaVersion,
    autoUpdate,
  };
}

function normalizeStringArray(value: string[] | undefined, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  const normalized = value
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.toLowerCase());
  return normalized.length > 0 ? normalized : [...fallback];
}
