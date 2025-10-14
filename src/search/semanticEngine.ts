import { readFileSync, existsSync, statSync } from "fs";
import { join, relative } from "path";
import type { Provider } from "../providers/base.js";
import { CodeChunker, type CodeChunk } from "./chunker.js";
import { EmbeddingStore, type EmbeddingRecord } from "../context/embeddingStore.js";
import { glob } from "glob";

export interface SearchResult {
  filepath: string; // Relative path
  chunkId: string; // Unique chunk identifier
  content: string; // Code snippet
  score: number; // Similarity score 0-1
  startLine: number; // Line number in file
  endLine: number;
  language?: string; // Programming language
  symbolName?: string; // Function/class name
  symbolType?: string; // 'function' | 'class' | 'interface' | 'type'
}

export interface SearchOptions {
  limit?: number; // Max results (default: 10)
  minScore?: number; // Min similarity (default: 0.5)
  filePattern?: string; // Glob pattern filter
  language?: string; // Filter by language
  includeTests?: boolean; // Include test files (default: false)
}

export interface IndexStats {
  totalChunks: number;
  totalFiles: number;
  lastIndexed: Date | null;
  model: string;
  dimensions: number;
}

export class SemanticSearchEngine {
  private chunker: CodeChunker;
  private embeddingStore: EmbeddingStore;
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
  ]);

  constructor(
    private cwd: string,
    private provider: Provider,
    private embeddingModel: string
  ) {
    this.chunker = new CodeChunker();
    this.embeddingStore = new EmbeddingStore();
  }

  /**
   * Search codebase using natural language query
   */
  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const {
      limit = 10,
      minScore = 0.5,
      filePattern,
      language,
      includeTests = false,
    } = options;

    // Validate query
    if (!query || query.trim().length < 3) {
      throw new Error("Query must be at least 3 characters");
    }

    // Check if provider supports embeddings
    if (!this.provider.embed) {
      throw new Error("Provider does not support embeddings");
    }

    // Generate query embedding
    const queryEmbeddings = await this.provider.embed([query], {
      model: this.embeddingModel,
    });

    if (!queryEmbeddings || queryEmbeddings.length === 0 || !queryEmbeddings[0]) {
      throw new Error("Failed to generate query embedding");
    }

    const queryVector = queryEmbeddings[0];

    // Get all indexed chunks
    const normalizedRoot = this.cwd.split("\\").join("/");
    const entries = this.embeddingStore.getEntries(normalizedRoot);

    if (entries.length === 0) {
      return [];
    }

    // Filter by model (only search chunks embedded with the same model)
    const filteredEntries = entries.filter((entry) => {
      // Check if any record in the array matches the model
      const records = Array.isArray(entry.record) ? entry.record : [entry.record];
      return records.some((rec: any) => rec.model === this.embeddingModel);
    });

    // Calculate similarity scores
    const scored: Array<SearchResult & { entry: any }> = [];

    for (const entry of filteredEntries) {
      const filepath = entry.path;

      // Apply filters
      if (filePattern && !this.matchesPattern(filepath, filePattern)) {
        continue;
      }

      if (!includeTests && this.isTestFile(filepath)) {
        continue;
      }

      // Process each chunk in the file
      const records = Array.isArray(entry.record) ? entry.record : [entry.record];
      for (const record of records) {
        if (record.model !== this.embeddingModel) {
          continue;
        }

        if (language && record.language !== language) {
          continue;
        }

        const score = this.cosineSimilarity(queryVector, record.vector);

        if (score >= minScore) {
          scored.push({
            filepath,
            chunkId: record.chunkId || "",
            content: record.content || "",
            score,
            startLine: record.startLine || 0,
            endLine: record.endLine || 0,
            language: record.language,
            symbolName: record.symbolName,
            symbolType: record.symbolType,
            entry,
          });
        }
      }
    }

    // Sort by score (descending) and take top N
    scored.sort((a, b) => b.score - a.score);
    const topResults = scored.slice(0, limit);

    // Load actual content if not stored in embedding
    const results: SearchResult[] = [];
    for (const result of topResults) {
      let content = result.content;

      // If content is not stored, read from file
      if (!content || content.trim().length === 0) {
        try {
          const fullPath = join(this.cwd, result.filepath);
          const fileContent = readFileSync(fullPath, "utf-8");
          const lines = fileContent.split("\n");
          const chunkLines = lines.slice(result.startLine, result.endLine + 1);
          content = chunkLines.join("\n");
        } catch (error) {
          console.warn(`Failed to read content from ${result.filepath}:`, error);
          content = "";
        }
      }

      results.push({
        filepath: result.filepath,
        chunkId: result.chunkId,
        content,
        score: result.score,
        startLine: result.startLine,
        endLine: result.endLine,
        language: result.language,
        symbolName: result.symbolName,
        symbolType: result.symbolType,
      });
    }

    return results;
  }

  /**
   * Reindex a specific file or the entire project
   */
  async reindex(filepath?: string): Promise<void> {
    if (filepath) {
      await this.indexFile(filepath);
    } else {
      await this.indexProject();
    }
  }

  /**
   * Index a specific file
   */
  private async indexFile(filepath: string): Promise<void> {
    const fullPath = join(this.cwd, filepath);

    if (!existsSync(fullPath)) {
      throw new Error(`File not found: ${filepath}`);
    }

    const stats = statSync(fullPath);
    if (!stats.isFile()) {
      throw new Error(`Not a file: ${filepath}`);
    }

    // Read file content
    const content = readFileSync(fullPath, "utf-8");

    // Chunk the file
    const chunks = this.chunker.chunk(filepath, content);

    if (chunks.length === 0) {
      return;
    }

    // Batch embed chunks
    const texts = chunks.map((chunk) => chunk.content);
    const embeddings = await this.batchEmbed(texts);

    // Store embeddings
    const normalizedRoot = this.cwd.split("\\").join("/");
    const normalizedPath = filepath.split("\\").join("/");

    const records: any[] = chunks.map((chunk, i) => ({
      vector: embeddings[i],
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      chunkId: chunk.id,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      symbolName: chunk.metadata.symbolName,
      symbolType: chunk.metadata.symbolType,
      language: chunk.language,
      model: this.embeddingModel,
      content: chunk.content, // Store content for quick access
    }));

    this.embeddingStore.upsertEntry(normalizedRoot, normalizedPath, records as any);
  }

  /**
   * Index the entire project
   */
  private async indexProject(): Promise<void> {
    // Find all code files
    const patterns = [
      "**/*.js",
      "**/*.jsx",
      "**/*.ts",
      "**/*.tsx",
      "**/*.py",
      "**/*.go",
      "**/*.rs",
      "**/*.java",
      "**/*.c",
      "**/*.cpp",
      "**/*.h",
      "**/*.hpp",
    ];

    const ignorePatterns = Array.from(this.ignoreDirs).map((dir) => `**/${dir}/**`);

    const files = await glob(patterns, {
      cwd: this.cwd,
      ignore: ignorePatterns,
      nodir: true,
    });

    console.log(`Found ${files.length} files to index`);

    // Index files in batches
    const batchSize = 10;
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (file) => {
          try {
            await this.indexFile(file);
          } catch (error) {
            console.warn(`Failed to index ${file}:`, error);
          }
        })
      );
      console.log(`Indexed ${Math.min(i + batchSize, files.length)}/${files.length} files`);
    }

    console.log("Indexing complete!");
  }

  /**
   * Get indexing statistics
   */
  getIndexStats(): IndexStats {
    const normalizedRoot = this.cwd.split("\\").join("/");
    const entries = this.embeddingStore.getEntries(normalizedRoot);

    let totalChunks = 0;
    let lastIndexed: Date | null = null;

    for (const entry of entries) {
      if (Array.isArray(entry.record)) {
        totalChunks += entry.record.length;
      }
    }

    // TODO: Track last indexed time in embedding store
    // For now, return null
    lastIndexed = null;

    return {
      totalChunks,
      totalFiles: entries.length,
      lastIndexed,
      model: this.embeddingModel,
      dimensions: 0, // Will be set after first embedding
    };
  }

  /**
   * Batch embed texts with the provider
   */
  private async batchEmbed(texts: string[]): Promise<number[][]> {
    if (!this.provider.embed) {
      throw new Error("Provider does not support embeddings");
    }

    const batchSize = 50; // Process 50 chunks at a time
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const embeddings = await this.provider.embed(batch, {
        model: this.embeddingModel,
      });
      allEmbeddings.push(...embeddings);
    }

    return allEmbeddings;
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    const len = Math.min(a.length, b.length);
    let dot = 0;
    let magA = 0;
    let magB = 0;

    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }

    magA = Math.sqrt(magA);
    magB = Math.sqrt(magB);

    if (magA === 0 || magB === 0) {
      return 0;
    }

    return dot / (magA * magB);
  }

  /**
   * Check if filepath matches a glob pattern
   */
  private matchesPattern(filepath: string, pattern: string): boolean {
    // Simple glob matching (can be improved with minimatch library)
    const regex = new RegExp(
      "^" +
        pattern
          .replace(/\./g, "\\.")
          .replace(/\*\*/g, ".*")
          .replace(/\*/g, "[^/]*")
          .replace(/\?/g, ".") +
        "$"
    );
    return regex.test(filepath);
  }

  /**
   * Check if file is a test file
   */
  private isTestFile(filepath: string): boolean {
    const testPatterns = [
      /\.test\./,
      /\.spec\./,
      /_test\./,
      /_spec\./,
      /\/tests?\//,
      /\/specs?\//,
      /__tests__\//,
    ];
    return testPatterns.some((pattern) => pattern.test(filepath));
  }
}
