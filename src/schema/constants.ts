export const OPENCLAW_SCHEMA_URI = "openclaw-schema://live/openclaw.schema.json";

export const DEFAULT_MANIFEST_URL =
  process.env.OPENCLAW_MANIFEST_URL ??
  "https://raw.githubusercontent.com/muxammadreza/openclaw-config-vscode/main/schemas/live/manifest.json";

export const DEFAULT_ALLOWED_HOSTS = ["raw.githubusercontent.com"] as const;
export const DEFAULT_ALLOWED_REPOSITORIES = ["muxammadreza/openclaw-config-vscode"] as const;

export const CONFIG_FILE_NAME = "openclaw.json";

export const ARTIFACT_FILE_NAMES = {
  schema: "openclaw.schema.json",
  uiHints: "openclaw.ui-hints.json",
  validator: "openclaw.validator.mjs",
  manifest: "manifest.json",
} as const;
