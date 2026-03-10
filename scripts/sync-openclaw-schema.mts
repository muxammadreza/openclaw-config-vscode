#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { build } from "esbuild";

type SchemaManifestV1 = {
  version: 1;
  openclawCommit: string;
  generatedAt: string;
  artifacts: {
    schema: { url: string; sha256: string };
    uiHints: { url: string; sha256: string };
    validator: { url: string; sha256: string };
  };
};

type GitHubRelease = {
  tag_name: string;
  prerelease?: boolean;
  draft?: boolean;
};

const MIN_SUPPORTED_RELEASE = "v2026.2.13";
const TRUSTED_OPENCLAW_REPO = "https://github.com/openclaw/openclaw.git";
const OPENCLAW_REPO = normalizeOpenClawRepo(process.env.OPENCLAW_REPO ?? TRUSTED_OPENCLAW_REPO);
let TARGET_REFS = process.env.OPENCLAW_REF ? [process.env.OPENCLAW_REF] : [];
let LIVE_REF: string | null = process.env.OPENCLAW_REF ?? null;
const ARTIFACT_REPOSITORY =
  process.env.SCHEMA_REPOSITORY ?? process.env.GITHUB_REPOSITORY ?? "muxammadreza/openclaw-config-vscode";
const ARTIFACT_REF = process.env.SCHEMA_ARTIFACT_REF ?? "main";
const FORCE_SYNC = process.env.FORCE_SYNC === "1";

const projectRoot = process.cwd();
const schemasRoot = path.join(projectRoot, "schemas");
const liveOutputDir = path.join(schemasRoot, "live");

async function main(): Promise<void> {
  if (TARGET_REFS.length > 0) {
    TARGET_REFS = filterSupportedRefs(TARGET_REFS);
    LIVE_REF = TARGET_REFS[0] ?? null;
    if (TARGET_REFS.length === 0) {
      throw new Error(
        `OPENCLAW_REF must be ${MIN_SUPPORTED_RELEASE} or newer when running schema sync.`,
      );
    }
  }

  let isLatestResolved = false;
  if (TARGET_REFS.length === 0) {
    const headers = new Headers({
      "User-Agent": "openclaw-config-vscode",
      "Accept": "application/vnd.github.v3+json",
    });
    if (process.env.GITHUB_TOKEN) {
      headers.set("Authorization", `Bearer ${process.env.GITHUB_TOKEN}`);
    }

    const res = await fetch("https://api.github.com/repos/openclaw/openclaw/releases?per_page=100", { headers });
    if (!res.ok) {
      throw new Error(`Failed to fetch releases from GitHub API: ${res.statusText}`);
    }
    const data = (await res.json()) as GitHubRelease[];
    TARGET_REFS = data
      .filter((release) => !release.draft && typeof release.tag_name === "string" && release.tag_name.trim())
      .map((release) => release.tag_name.trim());
    TARGET_REFS = filterSupportedRefs(TARGET_REFS);
    LIVE_REF =
      filterSupportedRefs(
        data
          .filter((release) => !release.draft && !release.prerelease && release.tag_name?.trim())
          .map((release) => release.tag_name.trim()),
      )[0] ??
      TARGET_REFS[0] ??
      null;
    console.log(`Resolved ${TARGET_REFS.length} OpenClaw releases.`);
    isLatestResolved = true;
  }

  for (const ref of TARGET_REFS) {
    console.log(`\n--- Syncing Schema for ${ref} ---`);
    const isLatest = isLatestResolved && LIVE_REF === ref;
    const refOutputDir = path.join(schemasRoot, ref);

    await fs.mkdir(refOutputDir, { recursive: true });
    if (isLatest) {
      await fs.mkdir(liveOutputDir, { recursive: true });
    }

    const upstreamHead = await resolveRemoteHeadCommit(ref);
    const refManifestPath = path.join(refOutputDir, "manifest.json");
    const currentManifest = await readManifestIfExists(refManifestPath);

    if (
      currentManifest &&
      currentManifest.openclawCommit === upstreamHead &&
      !FORCE_SYNC &&
      (await hasCompleteArtifactSet(refOutputDir))
    ) {
      console.log(`[${ref}] No schema update needed (commit ${upstreamHead}).`);

      // If it's the latest tag, we still need to ensure live/ is up to date
      if (isLatest) {
        await cloneArtifactsToLive(refOutputDir, liveOutputDir, currentManifest);
        console.log(`[latest] Synced live/ artifacts from ${ref}.`);
      }

      continue;
    }

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-schema-sync-"));
    const openclawDir = path.join(tempRoot, "openclaw");
    try {
      await run("git", ["clone", "--depth", "1", "--branch", ref, OPENCLAW_REPO, openclawDir]);
      const commit = (await run("git", ["rev-parse", "HEAD"], { cwd: openclawDir })).stdout.trim();
      await run("pnpm", ["install", "--no-frozen-lockfile", "--ignore-scripts"], { cwd: openclawDir });

      try {
        await exportSchemaArtifacts(openclawDir, refOutputDir, tempRoot, ref);
      } catch (err) {
        console.error(`[${ref}] Failed to export config schema: ${err instanceof Error ? err.message : String(err)}`);
        if (isLatest) {
          throw new Error(`Critical failure exporting latest schema for ${ref}. Cannot continue.`);
        }
        console.warn(`[${ref}] Skipping artifact generation due to export error.`);
        continue;
      }

      await buildValidatorArtifact(openclawDir, refOutputDir, tempRoot);

      const schema = await fs.readFile(path.join(refOutputDir, "openclaw.schema.json"), "utf8");
      const uiHints = await fs.readFile(path.join(refOutputDir, "openclaw.ui-hints.json"), "utf8");
      const validator = await fs.readFile(path.join(refOutputDir, "openclaw.validator.mjs"), "utf8");

      const baseUrl = `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${ARTIFACT_REF}/schemas/${ref}`;
      const manifest: SchemaManifestV1 = {
        version: 1,
        openclawCommit: commit,
        generatedAt: new Date().toISOString(),
        artifacts: {
          schema: {
            url: `${baseUrl}/openclaw.schema.json`,
            sha256: hash(schema),
          },
          uiHints: {
            url: `${baseUrl}/openclaw.ui-hints.json`,
            sha256: hash(uiHints),
          },
          validator: {
            url: `${baseUrl}/openclaw.validator.mjs`,
            sha256: hash(validator),
          },
        },
      };

      await fs.writeFile(refManifestPath, JSON.stringify(manifest, null, 2), "utf8");

      console.log(`[${ref}] Schema artifacts updated to commit ${commit}.`);
      console.log(`[${ref}] Manifest written to ${refManifestPath}.`);

      if (isLatest) {
        await cloneArtifactsToLive(refOutputDir, liveOutputDir, manifest);
        console.log(`[latest] Synced live/ artifacts from ${ref}.`);
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }
}

async function cloneArtifactsToLive(srcDir: string, destDir: string, manifest: SchemaManifestV1) {
  const files = [
    "openclaw.schema.json",
    "openclaw.ui-hints.json",
    "openclaw.validator.mjs",
  ];
  for (const file of files) {
    await fs.copyFile(path.join(srcDir, file), path.join(destDir, file));
  }

  // Create a deep copy of the manifest to amend URLs
  const liveManifest = JSON.parse(JSON.stringify(manifest)) as SchemaManifestV1;
  const baseUrl = `https://raw.githubusercontent.com/${ARTIFACT_REPOSITORY}/${ARTIFACT_REF}/schemas/live`;

  liveManifest.artifacts.schema.url = `${baseUrl}/openclaw.schema.json`;
  liveManifest.artifacts.uiHints.url = `${baseUrl}/openclaw.ui-hints.json`;
  liveManifest.artifacts.validator.url = `${baseUrl}/openclaw.validator.mjs`;

  await fs.writeFile(path.join(destDir, "manifest.json"), JSON.stringify(liveManifest, null, 2), "utf8");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeOpenClawRepo(rawRepo: string): string {
  const trimmed = rawRepo.trim();
  const parsed = new URL(trimmed || TRUSTED_OPENCLAW_REPO);
  const normalizedPath = parsed.pathname.replace(/\/+$/, "");
  const trustedPath =
    normalizedPath === "/openclaw/openclaw" || normalizedPath === "/openclaw/openclaw.git";

  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || !trustedPath) {
    throw new Error(
      `OPENCLAW_REPO must point to ${TRUSTED_OPENCLAW_REPO} (received ${trimmed || "<empty>"}).`,
    );
  }

  return `${parsed.protocol}//${parsed.hostname}${normalizedPath}`;
}

function filterSupportedRefs(refs: string[]): string[] {
  return refs.filter((ref) => isSupportedReleaseTag(ref));
}

function isSupportedReleaseTag(ref: string): boolean {
  const parsed = parseCalendarReleaseTag(ref);
  const minimum = parseCalendarReleaseTag(MIN_SUPPORTED_RELEASE);
  if (!parsed || !minimum) {
    return false;
  }
  return compareReleaseBase(parsed, minimum) >= 0;
}

function parseCalendarReleaseTag(ref: string): [number, number, number] | null {
  const match = /^v(\d+)\.(\d+)\.(\d+)(?:-.+)?$/.exec(ref.trim());
  if (!match) {
    return null;
  }
  const [, year, month, day] = match;
  return [Number(year), Number(month), Number(day)];
}

function compareReleaseBase(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < left.length; index += 1) {
    const delta = left[index] - right[index];
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
}

async function resolveRemoteHeadCommit(ref: string): Promise<string> {
  const { stdout } = await run("git", ["ls-remote", OPENCLAW_REPO, ref, `${ref}^{}`]);
  const lines = stdout.trim().split("\n").filter(Boolean);
  const peeled = lines.find((line) => line.endsWith(`\trefs/tags/${ref}^{}`));
  const direct = lines.find((line) =>
    line.endsWith(`\trefs/tags/${ref}`) ||
    line.endsWith(`\trefs/heads/${ref}`) ||
    line.endsWith(`\t${ref}`),
  );
  const line = peeled ?? direct;
  if (!line) {
    throw new Error(`Unable to resolve remote OpenClaw head commit for ${ref}.`);
  }
  const [commit] = line.split("\t");
  if (!commit) {
    throw new Error("Malformed git ls-remote output.");
  }
  return commit.trim();
}

async function hasCompleteArtifactSet(dir: string): Promise<boolean> {
  const required = [
    "openclaw.schema.json",
    "openclaw.ui-hints.json",
    "openclaw.validator.mjs",
    "manifest.json",
  ];
  const checks = await Promise.all(
    required.map(async (filename) => {
      try {
        await fs.access(path.join(dir, filename));
        return true;
      } catch {
        return false;
      }
    }),
  );
  return checks.every(Boolean);
}

async function exportSchemaArtifacts(
  openclawDir: string,
  refOutputDir: string,
  tempRoot: string,
  ref: string,
): Promise<void> {
  try {
    await runPrimarySchemaExport(openclawDir, refOutputDir, tempRoot);
    return;
  } catch (primaryError) {
    console.warn(
      `[${ref}] Primary schema export failed; falling back to compatibility mode: ${
        primaryError instanceof Error ? primaryError.message : String(primaryError)
      }`,
    );
  }

  try {
    await runPatchedSchemaExport(openclawDir, refOutputDir, tempRoot);
    return;
  } catch (patchedError) {
    console.warn(
      `[${ref}] Patched schema export failed; falling back to compatibility bundle: ${
        patchedError instanceof Error ? patchedError.message : String(patchedError)
      }`,
    );
  }

  const fallbackSchemaModule =
    (await firstExistingPath(openclawDir, ["src/config/zod-schema.ts", "src/config/config.ts"])) ?? null;
  if (!fallbackSchemaModule) {
    throw new Error("No compatible schema source found for fallback export.");
  }

  const fallbackEntryPath = path.join(tempRoot, "export-config-schema-fallback.ts");
  const fallbackBundlePath = path.join(tempRoot, "export-config-schema-fallback.mjs");
  const zodModulePath = path.join(openclawDir, "node_modules", "zod", "index.js");
  await fs.writeFile(
    fallbackEntryPath,
    `import fs from "node:fs/promises";
import path from "node:path";
import * as schemaSourceModule from ${JSON.stringify(path.join(openclawDir, fallbackSchemaModule))};
import { z } from ${JSON.stringify(zodModulePath)};

function resolveExportedSchema(mod) {
  for (const key of ["OpenClawSchema", "ClawdbotSchema", "ClawdisSchema", "WarelaySchema"]) {
    const value = mod?.[key];
    if (value && typeof value === "object") {
      return value;
    }
  }
  return null;
}

function captureSchemaFromValidator(mod) {
  const validate =
    typeof mod?.validateConfigObjectRaw === "function"
      ? mod.validateConfigObjectRaw
      : typeof mod?.validateConfigObject === "function"
        ? mod.validateConfigObject
        : null;
  const zodPrototype = z?.ZodType?.prototype;
  if (!validate || !zodPrototype || typeof zodPrototype.safeParse !== "function") {
    return null;
  }

  const originalSafeParse = zodPrototype.safeParse;
  let captured = null;
  zodPrototype.safeParse = function patchedSafeParse(...args) {
    captured ??= this;
    return originalSafeParse.apply(this, args);
  };

  try {
    try {
      validate({});
    } catch {
      // The validation result is irrelevant here; we only need the schema instance.
    }
  } finally {
    zodPrototype.safeParse = originalSafeParse;
  }

  return captured;
}

function toJsonSchema(schema) {
  const attempts = [
    () => schema?.toJSONSchema?.({ io: "output", reused: "inline", cycles: "ref" }),
    () => schema?.toJSONSchema?.({ io: "output", reused: "inline" }),
    () => schema?.toJSONSchema?.({ io: "output" }),
    () => schema?.toJSONSchema?.(),
    () => z?.toJSONSchema?.(schema, { io: "output", reused: "inline", cycles: "ref" }),
    () => z?.toJSONSchema?.(schema, { io: "output" }),
    () => z?.toJSONSchema?.(schema),
  ];
  for (const attempt of attempts) {
    try {
      const result = attempt();
      if (result && typeof result === "object") {
        return result;
      }
    } catch {
      // Try the next conversion strategy.
    }
  }
  throw new Error("Unable to convert compatibility schema to JSON schema.");
}

async function main() {
  const outDir = process.argv[2];
  if (!outDir) {
    throw new Error("Missing output directory argument.");
  }

  await fs.mkdir(outDir, { recursive: true });
  const capturedSchema = resolveExportedSchema(schemaSourceModule) ?? captureSchemaFromValidator(schemaSourceModule);
  if (!capturedSchema) {
    throw new Error("No compatible Zod schema export found for compatibility export.");
  }

  const schema = toJsonSchema(capturedSchema);
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    schema.properties ??= {};
    schema.properties.$schema = { type: "string" };
    schema.title ??= "OpenClawConfig";
  }

  await fs.writeFile(path.join(outDir, "openclaw.schema.json"), JSON.stringify(schema, null, 2), "utf8");
  await fs.writeFile(path.join(outDir, "openclaw.ui-hints.json"), JSON.stringify({}, null, 2), "utf8");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
`,
    "utf8",
  );

  await build({
    absWorkingDir: openclawDir,
    entryPoints: [fallbackEntryPath],
    outfile: fallbackBundlePath,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    minify: false,
    sourcemap: false,
    legalComments: "none",
    treeShaking: true,
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
  });

  await run("node", [fallbackBundlePath, refOutputDir], { cwd: openclawDir });
}

async function runPrimarySchemaExport(openclawDir: string, refOutputDir: string, tempRoot: string): Promise<void> {
  const schemaModulePath = path.join(openclawDir, "src/config/schema.ts");
  if (!(await pathExists(schemaModulePath))) {
    throw new Error("Primary schema module not found.");
  }

  const exportScriptPath = path.join(tempRoot, "export-config-schema.ts");
  await fs.writeFile(
    exportScriptPath,
    `import fs from "node:fs/promises";
import path from "node:path";
import { buildConfigSchema } from ${JSON.stringify(schemaModulePath)};

async function main() {
  const outDir = process.argv[2];
  if (!outDir) {
    throw new Error("Missing output directory argument.");
  }

  await fs.mkdir(outDir, { recursive: true });
  const result = buildConfigSchema();
  const schema = result.schema;
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    const root = schema;
    root.properties ??= {};
    root.properties.$schema = { type: "string" };
  }
  await fs.writeFile(path.join(outDir, "openclaw.schema.json"), JSON.stringify(schema, null, 2), "utf8");
  await fs.writeFile(path.join(outDir, "openclaw.ui-hints.json"), JSON.stringify(result.uiHints, null, 2), "utf8");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
`,
    "utf8",
  );

  await run("node", ["--import", "tsx", exportScriptPath, refOutputDir], { cwd: projectRoot });
}

async function runPatchedSchemaExport(openclawDir: string, refOutputDir: string, tempRoot: string): Promise<void> {
  const schemaModulePath = path.join(openclawDir, "src/config/schema.ts");
  if (!(await pathExists(schemaModulePath))) {
    throw new Error("Patched schema module source not found.");
  }

  const rawSchemaSource = await fs.readFile(schemaModulePath, "utf8");
  const patchedSource = rawSchemaSource.replace(
    /import\s+\{\s*CHANNEL_IDS\s*\}\s+from\s+"..\/channels\/registry\.js";/,
    'const CHANNEL_IDS = [];',
  );
  if (patchedSource === rawSchemaSource) {
    throw new Error("Unable to patch CHANNEL_IDS import in schema.ts.");
  }

  const patchedSchemaModulePath = path.join(openclawDir, "src/config/.openclaw-schema-sync-patched.ts");
  const exportScriptPath = path.join(tempRoot, "export-config-schema-patched.ts");

  await fs.writeFile(patchedSchemaModulePath, patchedSource, "utf8");
  await fs.writeFile(
    exportScriptPath,
    `import fs from "node:fs/promises";
import path from "node:path";
import { buildConfigSchema } from ${JSON.stringify(patchedSchemaModulePath)};

async function main() {
  const outDir = process.argv[2];
  if (!outDir) {
    throw new Error("Missing output directory argument.");
  }

  await fs.mkdir(outDir, { recursive: true });
  const result = buildConfigSchema();
  const schema = result.schema;
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    const root = schema;
    root.properties ??= {};
    root.properties.$schema = { type: "string" };
  }
  await fs.writeFile(path.join(outDir, "openclaw.schema.json"), JSON.stringify(schema, null, 2), "utf8");
  await fs.writeFile(path.join(outDir, "openclaw.ui-hints.json"), JSON.stringify(result.uiHints, null, 2), "utf8");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
`,
    "utf8",
  );

  try {
    await run("node", ["--import", "tsx", exportScriptPath, refOutputDir], { cwd: projectRoot });
  } finally {
    await fs.rm(patchedSchemaModulePath, { force: true });
  }
}

async function buildValidatorArtifact(openclawDir: string, refOutputDir: string, tempRoot: string): Promise<void> {
  const validatorSourcePaths = await existingPaths(openclawDir, ["src/config/validation.ts", "src/config/config.ts"]);
  if (validatorSourcePaths.length === 0) {
    throw new Error("No compatible validator source found.");
  }

  const outputPath = path.join(refOutputDir, "openclaw.validator.mjs");
  const failures: string[] = [];
  for (const relativePath of validatorSourcePaths) {
    const entryPath = path.join(
      tempRoot,
      `openclaw-validator-${relativePath.replace(/[\\/]/g, "-").replace(/\.[^.]+$/, "")}.ts`,
    );
    await fs.writeFile(
      entryPath,
      `import * as validationModule from ${JSON.stringify(path.join(openclawDir, relativePath))};

function normalizeIssues(result) {
  if (!result || result.ok) {
    return [];
  }
  const issues = Array.isArray(result.issues) ? result.issues : [];
  return issues.map((issue) => ({
    path: typeof issue?.path === "string" ? issue.path : "",
    message: typeof issue?.message === "string" ? issue.message : "Invalid config.",
  }));
}

export function validate(raw) {
  const validateFn =
    typeof validationModule.validateConfigObjectRaw === "function"
      ? validationModule.validateConfigObjectRaw
      : typeof validationModule.validateConfigObject === "function"
        ? validationModule.validateConfigObject
        : typeof validationModule.validateConfigObjectRawWithPlugins === "function"
          ? validationModule.validateConfigObjectRawWithPlugins
          : typeof validationModule.validateConfigObjectWithPlugins === "function"
            ? validationModule.validateConfigObjectWithPlugins
            : null;

  if (!validateFn) {
    throw new Error("No compatible validator export found.");
  }

  return normalizeIssues(validateFn(raw));
}
`,
      "utf8",
    );

    try {
      await build({
        absWorkingDir: openclawDir,
        entryPoints: [entryPath],
        outfile: outputPath,
        bundle: true,
        format: "esm",
        platform: "node",
        target: "node20",
        minify: true,
        sourcemap: false,
        legalComments: "none",
        treeShaking: true,
        banner: {
          js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
        },
      });
      await verifyValidatorArtifact(outputPath);
      return;
    } catch (error) {
      failures.push(
        `${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  throw new Error(`Unable to build validator artifact. ${failures.join(" | ")}`);
}

async function verifyValidatorArtifact(absolutePath: string): Promise<void> {
  const verifyScript =
    "import(process.argv[1]).then((mod) => {" +
    "if (typeof mod.validate !== 'function') throw new Error('Missing validate export.');" +
    "const result = mod.validate({});" +
    "if (!Array.isArray(result)) throw new Error('Validator did not return an array.');" +
    "}).catch((error) => { console.error(error); process.exit(1); });";
  await run("node", ["--input-type=module", "--eval", verifyScript, absolutePath], { cwd: projectRoot });
}

async function existingPaths(rootDir: string, relativePaths: string[]): Promise<string[]> {
  const checks = await Promise.all(
    relativePaths.map(async (relativePath) => ((await pathExists(path.join(rootDir, relativePath))) ? relativePath : null)),
  );
  return checks.filter((value): value is string => Boolean(value));
}

async function firstExistingPath(rootDir: string, relativePaths: string[]): Promise<string | null> {
  const matches = await existingPaths(rootDir, relativePaths);
  return matches[0] ?? null;
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

async function readManifestIfExists(absolutePath: string): Promise<SchemaManifestV1 | null> {
  try {
    const raw = await fs.readFile(absolutePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<SchemaManifestV1>;
    if (parsed.version !== 1 || typeof parsed.openclawCommit !== "string") {
      return null;
    }
    return parsed as SchemaManifestV1;
  } catch {
    return null;
  }
}

async function run(
  command: string,
  args: string[],
  options?: { cwd?: string },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      process.stdout.write(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}.`));
    });
  });
}

await main();
