import { readdirSync, statSync, readFileSync } from "fs";
import type { Stats } from "fs";
import { join, relative } from "path";
import { EmbeddingStore } from "./embeddingStore.js";

interface FileInfo {
  path: string;
  size: number;
  mtimeMs: number;
  depth: number;
}

interface CachedContext {
  root: string;
  files: FileInfo[];
  scannedAt: number;
}

interface EmbeddingOptions {
  enabled: boolean;
  dimensions?: number;
  maxFileSize?: number;
}

export class ProjectContextManager {
  private static instance: ProjectContextManager;
  private cache = new Map<string, CachedContext>();
  private readonly ttlMs = 60_000;
  private maxDepth = 4;
  private maxFiles = 500;
  private embeddingEnabled = false;
  private embeddingDimensions = 256;
  private embeddingMaxFileSize = 200 * 1024;
  private readonly ignoreDirs = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    "coverage",
    ".next",
    ".turbo",
    "out",
    "tmp",
    "__pycache__",
    "venv",
    ".venv",
    "env",
    "site-packages",
    "vendor",
    "deps",
    "bower_components",
    ".mypy_cache",
    ".pytest_cache",
  ]);
  private readonly textExtensions = new Set([
    ".js",
    ".ts",
    ".tsx",
    ".jsx",
    ".json",
    ".md",
    ".yml",
    ".yaml",
    ".py",
    ".go",
    ".rs",
    ".java",
    ".c",
    ".cpp",
    ".h",
    ".hpp",
  ]);
  private readonly embeddingStore = new EmbeddingStore();

  static getInstance(): ProjectContextManager {
    if (!ProjectContextManager.instance) {
      ProjectContextManager.instance = new ProjectContextManager();
    }
    return ProjectContextManager.instance;
  }

  configureEmbeddings(options: EmbeddingOptions): void {
    this.embeddingEnabled = options.enabled;
    if (options.dimensions && options.dimensions >= 16 && options.dimensions <= 1024) {
      this.embeddingDimensions = options.dimensions;
    }
    if (options.maxFileSize && options.maxFileSize > 0) {
      this.embeddingMaxFileSize = options.maxFileSize;
    }
  }

  isEmbeddingActive(): boolean {
    return this.embeddingEnabled;
  }

  getContext(root: string): CachedContext {
    const rootPath = root;
    const normalizedRoot = rootPath.split("\\").join("/");
    const cached = this.cache.get(normalizedRoot);
    if (cached && Date.now() - cached.scannedAt < this.ttlMs) {
      return cached;
    }

    const files: FileInfo[] = [];
    const validPaths = new Set<string>();

    const walk = (dir: string, depth: number) => {
      if (depth > this.maxDepth || files.length >= this.maxFiles) {
        return;
      }

      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = join(dir, entry);
        try {
          const stats = statSync(fullPath);

          if (stats.isDirectory()) {
            if (!this.ignoreDirs.has(entry) && !entry.startsWith(".")) {
              walk(fullPath, depth + 1);
            }
          } else if (stats.isFile()) {
            const rel = relative(rootPath, fullPath).split("\\").join("/");
            validPaths.add(rel);
            files.push({
              path: rel,
              size: stats.size,
              mtimeMs: stats.mtimeMs,
              depth,
            });

            this.updateEmbedding(normalizedRoot, fullPath, rel, stats);

            if (files.length >= this.maxFiles) {
              break;
            }
          }
        } catch {
          continue;
        }
      }
    };

    walk(rootPath, 0);

    const fullyScanned = files.length < this.maxFiles;

    const context: CachedContext = {
      root: normalizedRoot,
      files,
      scannedAt: Date.now(),
    };
    this.cache.set(normalizedRoot, context);
    if (fullyScanned && this.embeddingEnabled) {
      this.embeddingStore.cleanup(normalizedRoot, validPaths);
    }
    return context;
  }

  getRelevantFiles(root: string, query: string, limit = 10): Array<{ path: string; score: number }> {
    const normalizedRoot = root.split("\\").join("/");
    const context = this.getContext(root);

    if (!this.embeddingEnabled || !query.trim()) {
      return context.files.slice(0, limit).map((file) => ({ path: file.path, score: 0 }));
    }

    const entries = this.embeddingStore.getEntries(normalizedRoot);
    if (entries.length === 0) {
      return context.files.slice(0, limit).map((file) => ({ path: file.path, score: 0 }));
    }

    const queryVector = this.computeEmbedding(query);
    if (!queryVector) {
      return context.files.slice(0, limit).map((file) => ({ path: file.path, score: 0 }));
    }

    const scored = entries
      .map(({ path: filePath, record }) => ({
        path: filePath,
        score: this.cosineSimilarity(queryVector, record.vector),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    if (scored.length === 0) {
      return context.files.slice(0, limit).map((file) => ({ path: file.path, score: 0 }));
    }

    return scored;
  }

  invalidate(root?: string): void {
    if (!root) {
      this.cache.clear();
      return;
    }
    const normalizedRoot = root.split("\\").join("/");
    this.cache.delete(normalizedRoot);
  }

  private updateEmbedding(
    normalizedRoot: string,
    fullPath: string,
    relativePath: string,
    stats: Stats
  ): void {
    if (!this.embeddingEnabled) {
      return;
    }

    if (stats.size > this.embeddingMaxFileSize) {
      return;
    }

    const extIndex = relativePath.lastIndexOf(".");
    const ext = extIndex >= 0 ? relativePath.slice(extIndex).toLowerCase() : "";
    if (ext && !this.textExtensions.has(ext)) {
      return;
    }

    const existing = this.embeddingStore.getEntry(normalizedRoot, relativePath);
    if (existing && existing.mtimeMs === stats.mtimeMs && existing.size === stats.size) {
      return;
    }

    let content = "";
    try {
      content = readFileSync(fullPath, "utf-8");
    } catch {
      return;
    }

    const vector = this.computeEmbedding(content);
    if (!vector) {
      return;
    }

    this.embeddingStore.upsertEntry(normalizedRoot, relativePath, {
      vector,
      mtimeMs: stats.mtimeMs,
      size: stats.size,
    });
  }

  private hashToken(token: string): number {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  private computeEmbedding(text: string): number[] | null {
    const tokens = text.toLowerCase().match(/[a-z0-9_]+/g);
    if (!tokens || tokens.length === 0) {
      return null;
    }

    const dim = this.embeddingDimensions;
    const vector = new Array(dim).fill(0);
    const limit = Math.min(tokens.length, 4096);

    for (let i = 0; i < limit; i++) {
      const token = tokens[i];
      const index = this.hashToken(token) % dim;
      vector[index] += 1;
    }

    let magnitude = 0;
    for (let i = 0; i < dim; i++) {
      magnitude += vector[i] * vector[i];
    }
    magnitude = Math.sqrt(magnitude);
    if (magnitude === 0) {
      return null;
    }

    for (let i = 0; i < dim; i++) {
      vector[i] = vector[i] / magnitude;
    }
    return vector;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    const len = Math.min(a.length, b.length);
    let dot = 0;
    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i];
    }
    return dot;
  }
}
