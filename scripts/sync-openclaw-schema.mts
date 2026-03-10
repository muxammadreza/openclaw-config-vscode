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

const TRUSTED_OPENCLAW_REPO = "https://github.com/openclaw/openclaw.git";
const OPENCLAW_REPO = normalizeOpenClawRepo(process.env.OPENCLAW_REPO ?? TRUSTED_OPENCLAW_REPO);
let TARGET_REFS = process.env.OPENCLAW_REF ? [process.env.OPENCLAW_REF] : [];
const ARTIFACT_REPOSITORY =
  process.env.SCHEMA_REPOSITORY ?? process.env.GITHUB_REPOSITORY ?? "muxammadreza/openclaw-config-vscode";
const ARTIFACT_REF = process.env.SCHEMA_ARTIFACT_REF ?? "main";
const FORCE_SYNC = process.env.FORCE_SYNC === "1";

const projectRoot = process.cwd();
const schemasRoot = path.join(projectRoot, "schemas");
const liveOutputDir = path.join(schemasRoot, "live");

async function main(): Promise<void> {
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
    const data = await res.json() as { tag_name: string }[];
    TARGET_REFS = data.map(release => release.tag_name);
    console.log(`Resolved ${TARGET_REFS.length} OpenClaw releases.`);
    isLatestResolved = true;
  }

  const latestTag = TARGET_REFS[0];

  for (const ref of TARGET_REFS) {
    console.log(`\n--- Syncing Schema for ${ref} ---`);
    const isLatest = isLatestResolved && ref === latestTag;
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
      
      // Use --no-frozen-lockfile to avoid checksum mismatches for different platforms/pnpm versions during upstream clone
      await run("pnpm", ["install", "--no-frozen-lockfile", "--ignore-scripts"], { cwd: openclawDir });

      const exportScriptPath = path.join(tempRoot, "export-config-schema.ts");
      const validatorEntryPath = path.join(tempRoot, "openclaw-validator-entry.ts");

      await fs.writeFile(
        exportScriptPath,
        `import fs from "node:fs/promises";
import path from "node:path";
import { buildConfigSchema } from ${JSON.stringify(path.join(openclawDir, "src/config/schema.ts"))};

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

      await fs.writeFile(
        validatorEntryPath,
        `import { validateConfigObjectRaw } from ${JSON.stringify(path.join(openclawDir, "src/config/validation.ts"))};

export function validate(raw) {
  const result = validateConfigObjectRaw(raw);
  if (result.ok) {
    return [];
  }
  return result.issues.map((issue) => ({
    path: issue.path ?? "",
    message: issue.message,
  }));
}
`,
        "utf8",
      );

      await run("node", ["--import", "tsx", exportScriptPath, refOutputDir], { cwd: projectRoot });

      await build({
        absWorkingDir: openclawDir,
        entryPoints: [validatorEntryPath],
        outfile: path.join(refOutputDir, "openclaw.validator.mjs"),
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
    } catch (error) {
      console.error(`\n[!] FAILED to sync schema for tag ${ref}:`);
      console.error(error);
      
      if (isLatest) {
        console.error(`[CRITICAL] Latest tag ${ref} failed to build. Failing the entire sync.`);
        throw error;
      }
      
      console.warn(`[WARN] Skipping broken release ${ref}. Existing artifacts (if any) will remain untouched.`);
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

async function resolveRemoteHeadCommit(ref: string): Promise<string> {
  const { stdout } = await run("git", ["ls-remote", OPENCLAW_REPO, ref]);
  const line = stdout.trim().split("\n").find(Boolean);
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
