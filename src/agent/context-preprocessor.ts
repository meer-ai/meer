import { existsSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { glob } from 'glob';

export interface RelevantFile {
  path: string;
  relevanceScore: number;
  reason: string;
}

export class ContextPreprocessor {
  constructor(private cwd: string) {}

  /**
   * Extract keywords from user message
   */
  private extractKeywords(message: string): string[] {
    // Remove common words
    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
      'do', 'does', 'did', 'will', 'would', 'should', 'could', 'can', 'may',
      'might', 'must', 'this', 'that', 'these', 'those', 'i', 'you', 'he',
      'she', 'it', 'we', 'they', 'what', 'which', 'who', 'when', 'where',
      'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most',
      'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same',
      'so', 'than', 'too', 'very', 'just', 'with', 'from', 'into', 'about',
    ]);

    const words = message
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w));

    return [...new Set(words)];
  }

  /**
   * Find files by filename match
   */
  private async findByFilename(keywords: string[]): Promise<RelevantFile[]> {
    const results: RelevantFile[] = [];

    for (const keyword of keywords) {
      try {
        const pattern = `**/*${keyword}*`;
        const files = await glob(pattern, {
          cwd: this.cwd,
          ignore: ['node_modules/**', 'dist/**', '.git/**', 'build/**', 'coverage/**'],
          absolute: false,
        });

        for (const file of files.slice(0, 5)) {
          results.push({
            path: file,
            relevanceScore: 0.8,
            reason: `Filename matches "${keyword}"`,
          });
        }
      } catch (error) {
        // Continue on error
      }
    }

    return results;
  }

  /**
   * Find files by content match (grep)
   */
  private async findByContent(keywords: string[]): Promise<RelevantFile[]> {
    const { grep } = await import('../tools/index.js');
    const results: RelevantFile[] = [];

    for (const keyword of keywords) {
      const grepResult = grep('.', keyword, this.cwd, {
        maxResults: 10,
      });

      if (!grepResult.error && grepResult.result) {
        // Parse grep result to extract file paths
        const lines = grepResult.result.split('\n');
        const files = new Set<string>();

        for (const line of lines) {
          const match = line.match(/^([^:]+):/);
          if (match) {
            // Filter to only code files
            const filepath = match[1];
            if (/\.(ts|tsx|js|jsx|py|go|rs)$/.test(filepath)) {
              files.add(filepath);
            }
          }
        }

        for (const file of Array.from(files).slice(0, 5)) {
          results.push({
            path: file,
            relevanceScore: 0.9,
            reason: `Contains keyword "${keyword}"`,
          });
        }
      }
    }

    return results;
  }

  /**
   * Find recently modified files (likely related to current work)
   */
  private async findRecentlyModified(): Promise<RelevantFile[]> {
    try {
      const files = await glob('**/*.{ts,tsx,js,jsx,py,go,rs}', {
        cwd: this.cwd,
        ignore: ['node_modules/**', 'dist/**', '.git/**', 'build/**', 'coverage/**'],
        absolute: true,
      });

      const filesWithMtime = files
        .map(file => {
          try {
            const stats = statSync(file);
            return { path: relative(this.cwd, file), mtime: stats.mtime };
          } catch {
            return null;
          }
        })
        .filter(Boolean) as Array<{ path: string; mtime: Date }>;

      // Sort by modification time, get top 5
      const recent = filesWithMtime
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
        .slice(0, 5);

      return recent.map(f => ({
        path: f.path,
        relevanceScore: 0.6,
        reason: 'Recently modified',
      }));
    } catch {
      return [];
    }
  }

  /**
   * Find files in git diff (uncommitted changes)
   */
  private async findInGitDiff(): Promise<RelevantFile[]> {
    const { gitStatus } = await import('../tools/index.js');
    const result = gitStatus(this.cwd);

    if (result.error) return [];

    // Parse git status output
    const lines = result.result.split('\n');
    const files: RelevantFile[] = [];

    for (const line of lines) {
      const match = line.match(/modified:\s+(.+)/);
      if (match) {
        files.push({
          path: match[1].trim(),
          relevanceScore: 0.95,
          reason: 'Has uncommitted changes',
        });
      }
    }

    return files.slice(0, 5);
  }

  /**
   * Gather all relevant files using multiple strategies
   */
  async gatherContext(userMessage: string): Promise<RelevantFile[]> {
    const keywords = this.extractKeywords(userMessage);

    // Skip context gathering for simple greetings
    const simpleGreetings = /^(hi|hello|hey|thanks|thank you|bye|goodbye)$/i;
    if (simpleGreetings.test(userMessage.trim())) {
      return [];
    }

    // Run all strategies in parallel
    const [byFilename, byContent, recentFiles, gitFiles] = await Promise.all([
      this.findByFilename(keywords),
      this.findByContent(keywords),
      this.findRecentlyModified(),
      this.findInGitDiff(),
    ]);

    // Combine and deduplicate
    const allFiles = [...byFilename, ...byContent, ...recentFiles, ...gitFiles];
    const fileMap = new Map<string, RelevantFile>();

    for (const file of allFiles) {
      const existing = fileMap.get(file.path);
      if (!existing || file.relevanceScore > existing.relevanceScore) {
        fileMap.set(file.path, file);
      }
    }

    // Sort by relevance score, take top 10
    const sorted = Array.from(fileMap.values())
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, 10);

    return sorted;
  }

  /**
   * Build context prompt from files
   */
  buildContextPrompt(files: RelevantFile[]): string {
    if (files.length === 0) return '';

    let prompt = '\n## Relevant Project Files\n\n';
    prompt += 'The following files may be relevant to this task:\n\n';

    for (const file of files) {
      prompt += `### ${file.path}\n`;
      prompt += `*Relevance: ${file.reason}*\n\n`;

      try {
        const content = readFileSync(join(this.cwd, file.path), 'utf-8');
        const lines = content.split('\n');

        // Show first 50 lines or full file if smaller
        if (lines.length > 50) {
          prompt += '```\n';
          prompt += lines.slice(0, 50).join('\n');
          prompt += `\n... (${lines.length - 50} more lines)\n`;
          prompt += '```\n\n';
        } else {
          prompt += '```\n';
          prompt += content;
          prompt += '\n```\n\n';
        }
      } catch {
        prompt += '*[File could not be read]*\n\n';
      }
    }

    return prompt;
  }
}
