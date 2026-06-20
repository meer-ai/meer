import { parse } from "@babel/parser";
import traverse, { type NodePath } from "@babel/traverse";
import { readFileSync } from "fs";
import { extname } from "path";
import crypto from "crypto";

export interface CodeChunk {
  id: string; // hash(filepath + startLine + endLine)
  filepath: string;
  content: string;
  startLine: number;
  endLine: number;
  language: string;
  metadata: {
    symbolName?: string; // Function/class name
    symbolType?: string; // 'function' | 'class' | 'interface' | 'type'
    imports?: string[]; // Import statements
    docstring?: string; // JSDoc/docstring if present
  };
}

interface ChunkCandidate {
  startLine: number;
  endLine: number;
  symbolName?: string;
  symbolType?: string;
  docstring?: string;
}

export class CodeChunker {
  private readonly MAX_CHUNK_TOKENS = 2000; // ~8000 chars
  private readonly MIN_CHUNK_TOKENS = 50; // ~200 chars
  private readonly SLIDING_WINDOW_LINES = 300;
  private readonly SLIDING_WINDOW_OVERLAP = 50;
  private readonly CHARS_PER_TOKEN = 4; // Rough estimate

  /**
   * Chunk a code file into logical pieces
   */
  chunk(filepath: string, content: string): CodeChunk[] {
    const language = this.detectLanguage(filepath);
    const lines = content.split("\n");

    let candidates: ChunkCandidate[] = [];

    try {
      switch (language) {
        case "typescript":
        case "javascript":
        case "tsx":
        case "jsx":
          candidates = this.chunkJavaScript(content, language);
          break;
        case "python":
          candidates = this.chunkPython(content);
          break;
        default:
          candidates = this.chunkSlidingWindow(lines.length);
      }
    } catch (error) {
      // Fallback to sliding window if parsing fails
      console.warn(`Failed to parse ${filepath}, using sliding window:`, error);
      candidates = this.chunkSlidingWindow(lines.length);
    }

    // Filter out chunks that are too small or too large
    const validCandidates = candidates.filter((candidate) => {
      const chunkLines = lines.slice(candidate.startLine, candidate.endLine + 1);
      const chunkContent = chunkLines.join("\n");
      const estimatedTokens = chunkContent.length / this.CHARS_PER_TOKEN;

      return (
        estimatedTokens >= this.MIN_CHUNK_TOKENS &&
        estimatedTokens <= this.MAX_CHUNK_TOKENS
      );
    });

    // Convert candidates to CodeChunks
    return validCandidates.map((candidate) => {
      const chunkLines = lines.slice(candidate.startLine, candidate.endLine + 1);
      const chunkContent = chunkLines.join("\n");
      const id = this.generateChunkId(filepath, candidate.startLine, candidate.endLine);

      return {
        id,
        filepath,
        content: chunkContent,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        language,
        metadata: {
          symbolName: candidate.symbolName,
          symbolType: candidate.symbolType,
          docstring: candidate.docstring,
        },
      };
    });
  }

  /**
   * Chunk JavaScript/TypeScript code using AST
   */
  private chunkJavaScript(content: string, language: string): ChunkCandidate[] {
    const candidates: ChunkCandidate[] = [];
    const imports: string[] = [];

    const plugins: any[] = ["jsx"];
    if (language === "typescript" || language === "tsx") {
      plugins.push("typescript");
    }

    const ast = parse(content, {
      sourceType: "module",
      plugins,
      errorRecovery: true,
    });

    const self = this; // Store this reference for use in traverse callbacks

    traverse(ast, {
      // Capture imports
      ImportDeclaration(path: NodePath) {
        const source = (path.node as any).source.value;
        imports.push(source);
      },

      // Capture function declarations
      FunctionDeclaration(path: NodePath) {
        const node = path.node as any;
        if (node.loc && node.id) {
          const docstring = self.extractJSDocComment(path);
          candidates.push({
            startLine: node.loc.start.line - 1, // Convert to 0-indexed
            endLine: node.loc.end.line - 1,
            symbolName: node.id.name,
            symbolType: "function",
            docstring,
          });
        }
      },

      // Capture arrow functions assigned to variables
      VariableDeclarator(path: NodePath) {
        const node = path.node as any;
        if (
          node.init &&
          (node.init.type === "ArrowFunctionExpression" ||
            node.init.type === "FunctionExpression") &&
          node.id.type === "Identifier" &&
          node.loc
        ) {
          const docstring = self.extractJSDocComment(path);
          candidates.push({
            startLine: node.loc.start.line - 1,
            endLine: node.loc.end.line - 1,
            symbolName: node.id.name,
            symbolType: "function",
            docstring,
          });
        }
      },

      // Capture class declarations
      ClassDeclaration(path: NodePath) {
        const node = path.node as any;
        if (node.loc && node.id) {
          const docstring = self.extractJSDocComment(path);
          candidates.push({
            startLine: node.loc.start.line - 1,
            endLine: node.loc.end.line - 1,
            symbolName: node.id.name,
            symbolType: "class",
            docstring,
          });
        }
      },

      // Capture interface declarations (TypeScript)
      TSInterfaceDeclaration(path: NodePath) {
        const node = path.node as any;
        if (node.loc && node.id) {
          const docstring = self.extractJSDocComment(path);
          candidates.push({
            startLine: node.loc.start.line - 1,
            endLine: node.loc.end.line - 1,
            symbolName: node.id.name,
            symbolType: "interface",
            docstring,
          });
        }
      },

      // Capture type aliases (TypeScript)
      TSTypeAliasDeclaration(path: NodePath) {
        const node = path.node as any;
        if (node.loc && node.id) {
          const docstring = self.extractJSDocComment(path);
          candidates.push({
            startLine: node.loc.start.line - 1,
            endLine: node.loc.end.line - 1,
            symbolName: node.id.name,
            symbolType: "type",
            docstring,
          });
        }
      },
    });

    return candidates;
  }

  /**
   * Chunk Python code using regex patterns (AST parsing would require python-parser)
   */
  private chunkPython(content: string): ChunkCandidate[] {
    const candidates: ChunkCandidate[] = [];
    const lines = content.split("\n");

    let currentChunk: ChunkCandidate | null = null;
    let currentIndent = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Detect function definitions
      const funcMatch = trimmed.match(/^def\s+(\w+)\s*\(/);
      if (funcMatch) {
        if (currentChunk) {
          currentChunk.endLine = i - 1;
          candidates.push(currentChunk);
        }

        const indent = line.length - line.trimStart().length;
        currentIndent = indent;

        // Extract docstring if present
        let docstring: string | undefined;
        if (i + 1 < lines.length) {
          const nextLine = lines[i + 1].trim();
          if (nextLine.startsWith('"""') || nextLine.startsWith("'''")) {
            const docLines: string[] = [];
            let j = i + 1;
            while (j < lines.length) {
              docLines.push(lines[j].trim());
              if (
                j > i + 1 &&
                (lines[j].trim().endsWith('"""') || lines[j].trim().endsWith("'''"))
              ) {
                break;
              }
              j++;
            }
            docstring = docLines.join("\n");
          }
        }

        currentChunk = {
          startLine: i,
          endLine: i,
          symbolName: funcMatch[1],
          symbolType: "function",
          docstring,
        };
        continue;
      }

      // Detect class definitions
      const classMatch = trimmed.match(/^class\s+(\w+)(\(.*\))?:/);
      if (classMatch) {
        if (currentChunk) {
          currentChunk.endLine = i - 1;
          candidates.push(currentChunk);
        }

        const indent = line.length - line.trimStart().length;
        currentIndent = indent;

        currentChunk = {
          startLine: i,
          endLine: i,
          symbolName: classMatch[1],
          symbolType: "class",
        };
        continue;
      }

      // Update end line if we're still in a chunk
      if (currentChunk) {
        const indent = line.length - line.trimStart().length;
        // If we hit a line with same or less indentation and it's not empty, end chunk
        if (trimmed && indent <= currentIndent && i > currentChunk.startLine) {
          currentChunk.endLine = i - 1;
          candidates.push(currentChunk);
          currentChunk = null;
        } else {
          currentChunk.endLine = i;
        }
      }
    }

    // Close the last chunk
    if (currentChunk) {
      currentChunk.endLine = lines.length - 1;
      candidates.push(currentChunk);
    }

    return candidates;
  }

  /**
   * Fallback: sliding window chunking for unsupported languages
   */
  private chunkSlidingWindow(totalLines: number): ChunkCandidate[] {
    const candidates: ChunkCandidate[] = [];
    let startLine = 0;

    while (startLine < totalLines) {
      const endLine = Math.min(startLine + this.SLIDING_WINDOW_LINES - 1, totalLines - 1);
      candidates.push({
        startLine,
        endLine,
      });

      // Move window forward with overlap
      startLine += this.SLIDING_WINDOW_LINES - this.SLIDING_WINDOW_OVERLAP;
    }

    return candidates;
  }

  /**
   * Extract JSDoc comment from a Babel path
   */
  private extractJSDocComment(path: NodePath): string | undefined {
    const leadingComments = (path.node as any).leadingComments;
    if (!leadingComments || leadingComments.length === 0) {
      return undefined;
    }

    // Get the last leading comment (usually the JSDoc)
    const lastComment = leadingComments[leadingComments.length - 1];
    if (lastComment.type === "CommentBlock") {
      return lastComment.value.trim();
    }

    return undefined;
  }

  /**
   * Detect programming language from file extension
   */
  private detectLanguage(filepath: string): string {
    const ext = extname(filepath).toLowerCase();
    const languageMap: Record<string, string> = {
      ".js": "javascript",
      ".jsx": "jsx",
      ".ts": "typescript",
      ".tsx": "tsx",
      ".py": "python",
      ".go": "go",
      ".rs": "rust",
      ".java": "java",
      ".c": "c",
      ".cpp": "cpp",
      ".h": "c",
      ".hpp": "cpp",
      ".rb": "ruby",
      ".php": "php",
      ".swift": "swift",
      ".kt": "kotlin",
      ".scala": "scala",
    };

    return languageMap[ext] || "unknown";
  }

  /**
   * Generate a unique ID for a chunk
   */
  private generateChunkId(filepath: string, startLine: number, endLine: number): string {
    const content = `${filepath}:${startLine}:${endLine}`;
    return crypto.createHash("sha256").update(content).digest("hex").substring(0, 16);
  }
}
