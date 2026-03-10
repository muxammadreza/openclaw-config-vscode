import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import type { LocalRuntimeProfile } from "../schema/types";
import { isOpenClawConfigDocument } from "../utils";

const execFile = promisify(execFileCallback);
const DEFAULT_TIMEOUT_MS = 10_000;

type RuntimeValidatorOptions = {
  output: Pick<{ appendLine(value: string): void }, "appendLine">;
  getWorkspaceRoot: () => string | undefined;
};

type ValidationPayload = {
  valid?: boolean;
  issues?: Array<{
    path?: string;
    message?: string;
  }>;
};

export class OpenClawRuntimeValidatorDiagnostics {
  private readonly diagnostics = vscode.languages.createDiagnosticCollection("openclaw-runtime");

  constructor(private readonly options: RuntimeValidatorOptions) {}

  dispose(): void {
    this.diagnostics.dispose();
  }

  clear(document: vscode.TextDocument): void {
    this.diagnostics.delete(document.uri);
  }

  async validateDocument(
    document: vscode.TextDocument,
    runtime: LocalRuntimeProfile,
  ): Promise<void> {
    if (!isOpenClawConfigDocument(document) || !runtime.available || !runtime.validatorSupportsJson) {
      this.clear(document);
      return;
    }

    const versionAtStart = document.version;
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-config-vscode-"));
    const tempConfigPath = path.join(tempRoot, "openclaw.json");

    try {
      await fs.writeFile(tempConfigPath, document.getText(), "utf8");
      const result = await validateViaCli(tempConfigPath, runtime, this.options.getWorkspaceRoot());
      if (document.version !== versionAtStart) {
        return;
      }

      const diagnostics = (result.issues ?? []).map((issue) => {
        const range = findDiagnosticRange(document, issue.path ?? "");
        const diagnostic = new vscode.Diagnostic(
          range,
          issue.message?.trim() || "Invalid OpenClaw configuration.",
          vscode.DiagnosticSeverity.Error,
        );
        diagnostic.source = "openclaw-runtime";
        diagnostic.code = issue.path || "openclaw-runtime";
        return diagnostic;
      });

      this.diagnostics.set(document.uri, diagnostics);
    } catch (error) {
      this.options.output.appendLine(
        `[runtime] Validation failed for ${document.uri.fsPath}: ${toErrorMessage(error)}`,
      );
      this.clear(document);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }

  async revalidateAll(runtime: LocalRuntimeProfile): Promise<void> {
    const targets = vscode.workspace.textDocuments.filter((document) =>
      isOpenClawConfigDocument(document),
    );
    await Promise.all(targets.map((document) => this.validateDocument(document, runtime)));
  }
}

async function validateViaCli(
  configPath: string,
  runtime: LocalRuntimeProfile,
  workspaceRoot?: string,
): Promise<ValidationPayload> {
  try {
    const { stdout } = await execFile(runtime.commandPath, ["config", "validate", "--json"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      timeout: DEFAULT_TIMEOUT_MS,
      env: {
        ...process.env,
        OPENCLAW_CONFIG_PATH: configPath,
      },
      maxBuffer: 2 * 1024 * 1024,
    });
    return parseValidationPayload(stdout);
  } catch (error) {
    const execution = error as { stdout?: string; stderr?: string };
    const output = `${execution.stdout ?? ""}\n${execution.stderr ?? ""}`;
    const parsed = parseValidationPayload(output);
    if (typeof parsed.valid === "boolean") {
      return parsed;
    }
    throw error;
  }
}

function parseValidationPayload(raw: string): ValidationPayload {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    return {};
  }

  try {
    return JSON.parse(match[0]) as ValidationPayload;
  } catch {
    return {};
  }
}

function findDiagnosticRange(document: vscode.TextDocument, pathExpression: string): vscode.Range {
  const dottedPath = pathExpression
    .trim()
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (dottedPath.length === 0) {
    return new vscode.Range(document.positionAt(0), document.positionAt(0));
  }

  const raw = document.getText();
  let searchStart = 0;
  let matchOffset = 0;

  for (const segment of dottedPath) {
    const quoted = `"${segment}"`;
    const index = raw.indexOf(quoted, searchStart);
    if (index === -1) {
      return new vscode.Range(document.positionAt(matchOffset), document.positionAt(matchOffset));
    }
    matchOffset = index;
    searchStart = index + quoted.length;
  }

  return new vscode.Range(
    document.positionAt(matchOffset),
    document.positionAt(matchOffset + dottedPath.at(-1)!.length + 2),
  );
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
