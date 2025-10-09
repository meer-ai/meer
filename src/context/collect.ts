import { readFileSync, existsSync, statSync } from 'fs';
import { join, extname, relative } from 'path';
import { glob } from 'glob';
import type { Provider } from '../providers/base.js';

export interface CodeChunk {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
}

export interface ContextResult {
  chunks: CodeChunk[];
  totalFiles: number;
}

const SUPPORTED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.sql', '.md', '.json', '.yaml', '.yml'
]);

const IGNORE_PATTERNS = [
  '**/.git/**',
  '**/node_modules/**',
  '**/venv/**',
  '**/.venv/**',
  '**/env/**',
  '**/.next/**',
  '**/dist/**',
  '**/build/**',
  '**/.turbo/**',
  '**/coverage/**',
  '**/.cache/**',
  '**/target/**',
  '**/vendor/**',
  '**/deps/**',
  '**/site-packages/**',
  '**/__pycache__/**',
  '**/bower_components/**',
  '**/.mypy_cache/**',
  '**/.pytest_cache/**'
];

export function collectRepoFiles(rootPath: string = '.'): ContextResult {
  const chunks: CodeChunk[] = [];
  let totalFiles = 0;

  try {
    // Find all relevant files
    const pattern = '**/*';
    const files = glob.sync(pattern, {
      cwd: rootPath,
      ignore: IGNORE_PATTERNS,
      nodir: true
    });

    for (const file of files.slice(0, 20)) { // Limit to first 20 files
      const fullPath = join(rootPath, file);
      const ext = extname(file).toLowerCase();
      
      if (!SUPPORTED_EXTENSIONS.has(ext)) {
        continue;
      }

      try {
        const stats = statSync(fullPath);
        if (stats.size > 50 * 1024) { // Skip files larger than 50KB
          continue;
        }

        const content = readFileSync(fullPath, 'utf-8');
        totalFiles++;

        // Skip binary-like files
        if (isBinaryContent(content)) {
          continue;
        }

        // Chunk the file content
        const fileChunks = chunkFile(file, content);
        chunks.push(...fileChunks);
      } catch (error) {
        // Skip files that can't be read
        continue;
      }
    }
  } catch (error) {
    console.warn('Error collecting files:', error);
  }

  return { chunks, totalFiles };
}

function isBinaryContent(content: string): boolean {
  // Check for null bytes or high ratio of non-printable characters
  if (content.includes('\0')) return true;
  
  const printableChars = content.replace(/[\x20-\x7E\s]/g, '').length;
  const totalChars = content.length;
  
  return totalChars > 0 && printableChars / totalChars > 0.3;
}

function chunkFile(path: string, content: string, chunkSize: number = 800, overlap: number = 100): CodeChunk[] {
  const lines = content.split('\n');
  const chunks: CodeChunk[] = [];
  
  let currentChunk = '';
  let startLine = 1;
  let lineIndex = 0;

  for (const line of lines) {
    const lineWithNewline = line + '\n';
    
    if (currentChunk.length + lineWithNewline.length > chunkSize && currentChunk.length > 0) {
      // Save current chunk
      chunks.push({
        path,
        content: currentChunk.trim(),
        startLine,
        endLine: lineIndex
      });

      // Start new chunk with overlap
      const overlapLines = currentChunk.split('\n').slice(-Math.floor(overlap / 20));
      currentChunk = overlapLines.join('\n') + lineWithNewline;
      startLine = lineIndex - overlapLines.length + 1;
    } else {
      currentChunk += lineWithNewline;
    }
    
    lineIndex++;
  }

  // Add final chunk if it has content
  if (currentChunk.trim()) {
    chunks.push({
      path,
      content: currentChunk.trim(),
      startLine,
      endLine: lineIndex
    });
  }

  return chunks;
}

export async function topK(
  query: string,
  provider: Provider,
  chunks: CodeChunk[],
  k: number = 3
): Promise<CodeChunk[]> {
  if (!provider.embed || chunks.length === 0) {
    return [];
  }

  try {
    // Prepare texts for embedding
    const texts = [query, ...chunks.map(chunk => chunk.content)];
    
    // Get embeddings
    const embeddings = await provider.embed(texts);
    
    if (embeddings.length < 2) {
      return [];
    }

    const queryEmbedding = embeddings[0];
    const chunkEmbeddings = embeddings.slice(1);

    // Calculate cosine similarities
    const similarities = chunkEmbeddings.map((embedding, index) => ({
      chunk: chunks[index],
      similarity: cosineSimilarity(queryEmbedding, embedding)
    }));

    // Sort by similarity and return top-k
    return similarities
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k)
      .map(item => item.chunk);
  } catch (error) {
    console.warn('Error computing embeddings:', error);
    return [];
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  
  if (normA === 0 || normB === 0) return 0;
  
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function formatContext(chunks: CodeChunk[]): string {
  if (chunks.length === 0) return '';
  
  // Prioritize AGENTS.md files
  const agentsChunks = chunks.filter(chunk => 
    chunk.path.toLowerCase().includes('agents.md')
  );
  const otherChunks = chunks.filter(chunk => 
    !chunk.path.toLowerCase().includes('agents.md')
  );
  
  // Sort chunks with AGENTS.md first
  const sortedChunks = [...agentsChunks, ...otherChunks];
  
  const contextParts = sortedChunks.map(chunk => 
    `File: ${chunk.path} (lines ${chunk.startLine}-${chunk.endLine})\n${chunk.content}`
  );
  
  return `Context:\n${contextParts.join('\n\n---\n\n')}\n\n`;
}
