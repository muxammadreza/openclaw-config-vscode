import fs from "node:fs/promises";
import path from "node:path";
import type { PersistedResolvedRuntimeSchemaSnapshot } from "./types";

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export class ResolvedSnapshotStore {
  private readonly snapshotPath: string;

  constructor(cacheRoot: string) {
    this.snapshotPath = path.join(cacheRoot, "resolved-snapshot.json");
  }

  async load(cacheKey: string): Promise<PersistedResolvedRuntimeSchemaSnapshot | null> {
    const snapshot = await this.read();
    if (!snapshot || snapshot.metadata.cacheKey !== cacheKey) {
      return null;
    }
    return snapshot;
  }

  async save(snapshot: PersistedResolvedRuntimeSchemaSnapshot): Promise<void> {
    await fs.mkdir(path.dirname(this.snapshotPath), { recursive: true });
    await fs.writeFile(this.snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");
  }

  async clear(): Promise<void> {
    await fs.rm(this.snapshotPath, { force: true });
  }

  async read(): Promise<PersistedResolvedRuntimeSchemaSnapshot | null> {
    if (!(await exists(this.snapshotPath))) {
      return null;
    }
    try {
      return JSON.parse(await fs.readFile(this.snapshotPath, "utf8")) as PersistedResolvedRuntimeSchemaSnapshot;
    } catch {
      return null;
    }
  }
}
