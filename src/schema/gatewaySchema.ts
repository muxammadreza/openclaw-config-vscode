import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { extractJsonPayload } from "./pluginDiscovery";
import type { SchemaLookupResult } from "./types";

const execFile = promisify(execFileCallback);
const DEFAULT_TIMEOUT_MS = 8_000;

type ExecFileLike = typeof execFile;

export type GatewaySchemaPayload = {
  schema: Record<string, unknown>;
  uiHints: Record<string, unknown>;
  version?: string;
  generatedAt?: string;
};

export type GatewayLookupPayload = SchemaLookupResult;

export class OpenClawGatewaySchemaClient {
  constructor(
    private readonly options: {
      execFileFn?: ExecFileLike;
      timeoutMs?: number;
    } = {},
  ) {}

  async getSchema(commandPath: string, workspaceRoot?: string): Promise<GatewaySchemaPayload> {
    const payload = await this.call(commandPath, "config.schema", {}, workspaceRoot);
    if (!isGatewaySchemaPayload(payload)) {
      throw new Error("Gateway config.schema returned an invalid payload.");
    }
    return payload;
  }

  async lookupSchemaPath(
    commandPath: string,
    lookupPath: string,
    workspaceRoot?: string,
  ): Promise<GatewayLookupPayload> {
    const payload = await this.call(
      commandPath,
      "config.schema.lookup",
      { path: lookupPath },
      workspaceRoot,
    );
    if (!isSchemaLookupPayload(payload)) {
      throw new Error("Gateway config.schema.lookup returned an invalid payload.");
    }
    return payload;
  }

  private async call(
    commandPath: string,
    method: string,
    params: Record<string, unknown>,
    workspaceRoot?: string,
  ): Promise<unknown> {
    const { stdout, stderr } = await (this.options.execFileFn ?? execFile)(
      commandPath,
      [
        "gateway",
        "call",
        method,
        "--json",
        "--params",
        JSON.stringify(params),
      ],
      {
        cwd: workspaceRoot,
        encoding: "utf8",
        timeout: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      },
    );

    const parsed = extractJsonPayload(`${stdout}\n${stderr}`);
    if (parsed === null) {
      throw new Error(`Gateway ${method} returned no JSON payload.`);
    }
    return parsed;
  }
}

function isGatewaySchemaPayload(value: unknown): value is GatewaySchemaPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<GatewaySchemaPayload>;
  return (
    Boolean(candidate.schema) &&
    typeof candidate.schema === "object" &&
    !Array.isArray(candidate.schema) &&
    Boolean(candidate.uiHints) &&
    typeof candidate.uiHints === "object" &&
    !Array.isArray(candidate.uiHints)
  );
}

function isSchemaLookupPayload(value: unknown): value is GatewayLookupPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<GatewayLookupPayload>;
  return (
    typeof candidate.path === "string" &&
    Boolean(candidate.schema) &&
    typeof candidate.schema === "object" &&
    !Array.isArray(candidate.schema) &&
    Array.isArray(candidate.children)
  );
}
