import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

export interface EmbeddingRecord {
  vector: number[];
  mtimeMs: number;
  size: number;
}

interface EmbeddingCollection {
  entries: Record<string, EmbeddingRecord>;
  updatedAt: number;
}

interface EmbeddingDatabase {
  [root: string]: EmbeddingCollection;
}

export class EmbeddingStore {
  private dbPath: string;
  private db: EmbeddingDatabase = {};

  constructor() {
    const cacheDir = join(homedir(), ".meer", "cache");
    this.dbPath = join(cacheDir, "embeddings.json");
    this.load();
  }

  getEntry(root: string, relativePath: string): EmbeddingRecord | undefined {
    const collection = this.db[root];
    return collection?.entries?.[relativePath];
  }

  getEntries(root: string): Array<{ path: string; record: EmbeddingRecord }> {
    const collection = this.db[root];
    if (!collection) return [];
    return Object.entries(collection.entries).map(([path, record]) => ({ path, record }));
  }

  upsertEntry(root: string, relativePath: string, record: EmbeddingRecord): void {
    if (!this.db[root]) {
      this.db[root] = { entries: {}, updatedAt: Date.now() };
    }
    this.db[root].entries[relativePath] = record;
    this.db[root].updatedAt = Date.now();
    this.save();
  }

  removeEntry(root: string, relativePath: string): void {
    const collection = this.db[root];
    if (!collection) return;
    delete collection.entries[relativePath];
    collection.updatedAt = Date.now();
    this.save();
  }

  cleanup(root: string, validPaths: Set<string>): void {
    const collection = this.db[root];
    if (!collection) return;

    let dirty = false;
    for (const existingPath of Object.keys(collection.entries)) {
      if (!validPaths.has(existingPath)) {
        delete collection.entries[existingPath];
        dirty = true;
      }
    }

    if (dirty) {
      collection.updatedAt = Date.now();
      this.save();
    }
  }

  private load(): void {
    if (!existsSync(this.dbPath)) {
      this.db = {};
      return;
    }

    try {
      const raw = readFileSync(this.dbPath, "utf-8");
      this.db = JSON.parse(raw) as EmbeddingDatabase;
    } catch {
      this.db = {};
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.dbPath), { recursive: true });
      writeFileSync(this.dbPath, JSON.stringify(this.db));
    } catch (error) {
      console.warn("Failed to persist embedding cache:", error);
    }
  }
}
