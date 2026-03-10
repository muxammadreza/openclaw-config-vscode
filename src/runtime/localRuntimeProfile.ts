import { execFile as execFileCallback } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import type { LocalRuntimeProfile } from "../schema/types";

const execFile = promisify(execFileCallback);
const DEFAULT_TIMEOUT_MS = 8_000;

type RuntimeProfileOptions = {
  commandPath: string;
  workspaceRoot?: string;
  timeoutMs?: number;
};

type RuntimeProfileServiceOptions = {
  output: Pick<{ appendLine(value: string): void }, "appendLine">;
  execFileFn?: typeof execFile;
};

type CachedProfile = {
  key: string;
  value: Promise<LocalRuntimeProfile>;
};

export class LocalRuntimeProfileService {
  private cached: CachedProfile | null = null;
  private readonly loggedMessages = new Set<string>();

  constructor(private readonly options: RuntimeProfileServiceOptions) {}

  invalidate(): void {
    this.cached = null;
  }

  async getProfile(options: RuntimeProfileOptions): Promise<LocalRuntimeProfile> {
    const commandPath = options.commandPath.trim() || "openclaw";
    const key = JSON.stringify({
      commandPath,
      workspaceRoot: options.workspaceRoot ?? "",
    });

    if (!this.cached || this.cached.key !== key) {
      this.cached = {
        key,
        value: this.loadProfile({
          ...options,
          commandPath,
        }),
      };
    }

    return this.cached.value;
  }

  private async loadProfile(options: RuntimeProfileOptions): Promise<LocalRuntimeProfile> {
    const profile: LocalRuntimeProfile = {
      commandPath: options.commandPath,
      workspaceRoot: options.workspaceRoot,
      available: false,
      validatorSupportsJson: false,
    };

    try {
      const [versionResult, configFileResult, helpResult] = await Promise.all([
        (this.options.execFileFn ?? execFile)(options.commandPath, ["--version"], {
          cwd: options.workspaceRoot,
          encoding: "utf8",
          timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        }),
        (this.options.execFileFn ?? execFile)(options.commandPath, ["config", "file"], {
          cwd: options.workspaceRoot,
          encoding: "utf8",
          timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        }),
        (this.options.execFileFn ?? execFile)(options.commandPath, ["config", "validate", "--help"], {
          cwd: options.workspaceRoot,
          encoding: "utf8",
          timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        }).catch((error) => error as { stdout?: string; stderr?: string }),
      ]);

      const version = parseOpenClawVersion(versionResult.stdout);
      const configPath = normalizeConfigPath(configFileResult.stdout);
      const helpText = extractHelpText(helpResult);

      profile.available = true;
      profile.version = version ?? undefined;
      profile.versionTag = version ? `v${version}` : undefined;
      profile.configPath = configPath ?? undefined;
      profile.validatorSupportsJson = helpText.includes("--json");
      return profile;
    } catch (error) {
      profile.lastError = toErrorMessage(error);
      this.logRuntimeWarning(
        `[runtime] Failed to query local OpenClaw runtime: ${profile.lastError}`,
      );
      return profile;
    }
  }

  private logRuntimeWarning(message: string): void {
    if (this.loggedMessages.has(message)) {
      return;
    }
    this.loggedMessages.add(message);
    this.options.output.appendLine(message);
  }
}

function parseOpenClawVersion(stdout: string): string | null {
  const match = stdout.match(/OpenClaw\s+([0-9][0-9A-Za-z.+-]*)/i);
  return match?.[1]?.trim() || null;
}

function normalizeConfigPath(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("~/")) {
    return `${os.homedir()}${trimmed.slice(1)}`;
  }
  return trimmed;
}

function extractHelpText(result: { stdout?: string; stderr?: string } | { stdout: string; stderr: string }): string {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.toLowerCase();
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
