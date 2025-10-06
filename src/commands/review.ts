import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { readFileSync, existsSync, statSync } from 'fs';
import { join, extname } from 'path';
import { glob } from 'glob';
import { loadConfig } from '../config.js';
import type { ChatMessage } from '../providers/base.js';
import { detectLanguageFromPath } from '../utils/language.js';

const SUPPORTED_EXTENSIONS = new Set([
  // JavaScript/TypeScript
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  // Python
  '.py', '.pyw', '.pyx',
  // Go
  '.go',
  // Rust
  '.rs',
  // Java/Kotlin
  '.java', '.kt', '.kts',
  // C/C++
  '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp',
  // C#
  '.cs',
  // Ruby
  '.rb',
  // PHP
  '.php',
  // Swift
  '.swift',
  // Scala
  '.scala',
  // Database
  '.sql',
  // Markup/Config
  '.md', '.markdown', '.json', '.yaml', '.yml', '.toml', '.xml',
  // Shell
  '.sh', '.bash', '.zsh',
  // Web
  '.html', '.css', '.scss', '.sass', '.less', '.vue', '.svelte'
]);

class ReviewFormatter {
  private buffer = '';
  private inCodeBlock = false;

  formatChunk(chunk: string): string {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');

    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() || '';

    // Format complete lines
    const formattedLines = lines.map(line => this.formatLine(line));
    return formattedLines.join('\n') + (formattedLines.length > 0 ? '\n' : '');
  }

  flush(): string {
    if (this.buffer) {
      const formatted = this.formatLine(this.buffer);
      this.buffer = '';
      return formatted;
    }
    return '';
  }

  private formatLine(line: string): string {
    // Track code blocks
    if (line.startsWith('```')) {
      this.inCodeBlock = !this.inCodeBlock;
      return chalk.dim.gray(line);
    }

    // Don't format inside code blocks (except for minimal styling)
    if (this.inCodeBlock) {
      return chalk.gray(line);
    }

    let formatted = line;

    // Section headers with emojis
    if (line.includes('### 📊 Overview')) {
      return chalk.bold.blue(line);
    }
    if (line.includes('### ✅ Strengths')) {
      return chalk.bold.green(line);
    }
    if (line.includes('### 🚨 Critical Issues')) {
      return chalk.bold.red(line);
    }
    if (line.includes('### 💡 Improvement Opportunities')) {
      return chalk.bold.yellow(line);
    }
    if (line.includes('### ❓ Questions')) {
      return chalk.bold.magenta(line);
    }

    // Priority levels
    formatted = formatted.replace(/\*\*High Priority:\*\*/g, chalk.bold.red('⚠️  High Priority:'));
    formatted = formatted.replace(/\*\*Medium Priority:\*\*/g, chalk.bold.yellow('⚡ Medium Priority:'));
    formatted = formatted.replace(/\*\*Low Priority[^:]*:\*\*/g, chalk.bold.cyan('💡 Low Priority:'));

    // Critical issue components
    formatted = formatted.replace(/\*\*\[([^\]]+)\]\*\*:/g, chalk.bold.red('[$1]') + chalk.white(':'));
    formatted = formatted.replace(/- \*\*Location\*\*:/g, chalk.gray('  📍 Location:'));
    formatted = formatted.replace(/- \*\*Impact\*\*:/g, chalk.red('  ⚡ Impact:'));
    formatted = formatted.replace(/- \*\*Recommendation\*\*:/g, chalk.green('  ✅ Fix:'));

    // File:line references
    formatted = formatted.replace(
      /(\w+\.(ts|tsx|js|jsx|py|go|rs|java|kt|rb|php|sql|sh|css|html|vue|svelte|c|cpp|h|hpp)):(\d+)/g,
      chalk.cyan('$1') + chalk.gray(':') + chalk.yellow('$3')
    );

    // Bullet points
    if (/^- /.test(line)) {
      formatted = formatted.replace(/^- /, chalk.blue('  • '));
    }

    // Inline code
    formatted = formatted.replace(/`([^`]+)`/g, (_, code) => chalk.cyan.bold(`\`${code}\``));

    // Bold text (but preserve already colored text)
    formatted = formatted.replace(/\*\*([^*]+)\*\*/g, chalk.bold('$1'));

    return formatted;
  }
}

function buildReviewSystemPrompt(dominantLanguage?: string): string {
  const languageContext = dominantLanguage
    ? `\n\n**Primary Language Detected**: ${dominantLanguage}\nTailor your feedback to ${dominantLanguage}-specific idioms, conventions, and best practices.`
    : '';

  return `You are an elite code reviewer with 15+ years of experience across multiple programming languages and paradigms. Your expertise spans software architecture, security, performance optimization, and maintainable code design. You have a keen eye for subtle issues and a deep understanding of language-specific idioms and best practices.

Your mission is to review code comprehensively, providing actionable feedback that improves code quality, maintainability, security, and performance.${languageContext}

## Review Methodology

Systematically evaluate these dimensions:

### 1. Code Structure & Organization
- Single Responsibility Principle adherence
- Appropriate separation of concerns
- Logical grouping and module organization
- Function/method size and complexity (cyclomatic complexity)
- Appropriate use of design patterns

### 2. Naming & Readability
- Clear, descriptive, and consistent naming conventions
- Self-documenting code vs. unnecessary comments
- Appropriate use of comments for complex logic
- Code clarity and ease of understanding
- Avoid misleading or ambiguous names

### 3. Error Handling & Robustness
- Comprehensive error handling strategies
- Input validation and sanitization
- Edge case coverage (null, undefined, empty, boundary values)
- Graceful degradation and failure modes
- Proper error propagation and logging

### 4. Security Considerations
- Input validation and injection prevention (SQL, XSS, Command Injection)
- Authentication and authorization checks
- Sensitive data handling (credentials, PII, tokens)
- Common vulnerability patterns (OWASP Top 10)
- Secure defaults and principle of least privilege
- Dependency security and known vulnerabilities

### 5. Performance & Efficiency
- Algorithm complexity (time and space)
- Resource management (memory, connections, file handles)
- Unnecessary computations or redundant operations
- Appropriate data structure selection
- Database query optimization (N+1 queries, indexing)
- Caching opportunities

### 6. Maintainability & Extensibility
- DRY (Don't Repeat Yourself) principle
- SOLID principles application
- Code coupling and cohesion
- Future-proofing and extensibility
- Magic numbers and hard-coded values
- Configuration management

### 7. Testing & Testability
- Code testability and dependency injection
- Test coverage gaps
- Mock-friendly design
- Test data quality and edge cases

### 8. Language-Specific Best Practices
- Idiomatic usage of language features
- Standard library utilization
- Framework-specific conventions
- Community-accepted patterns
- Modern language features vs. legacy patterns

## Review Output Format

Structure your review **exactly** as follows:

### 📊 Overview
Provide a brief 2-3 sentence summary of the code's purpose and overall quality assessment. Include a quality score (1-10) if appropriate.

### ✅ Strengths
Highlight 2-4 things the code does well. Be specific and genuine. Examples:
- Strong type safety with comprehensive interfaces
- Excellent error handling with custom error classes
- Clean separation of concerns between layers

### 🚨 Critical Issues
**ONLY include if there are actual critical issues.** Issues that could cause bugs, security vulnerabilities, or significant problems:

**[Category Name]**: Clear description
- **Location**: Specific file:line reference
- **Impact**: Why this matters (security risk, data loss, crashes, etc.)
- **Recommendation**: Concrete fix with code example

Example:
**SQL Injection Vulnerability**: User input directly concatenated into SQL query
- **Location**: auth.ts:45
- **Impact**: Attackers can execute arbitrary SQL commands, leading to data breach
- **Recommendation**: Use parameterized queries:
\`\`\`typescript
db.query('SELECT * FROM users WHERE id = ?', [userId])
\`\`\`

### 💡 Improvement Opportunities

**High Priority:**
- Issues that significantly enhance quality, security, or performance
- Include file:line references, explanation, and code examples

**Medium Priority:**
- Refinements that improve maintainability or developer experience
- Include file:line references and clear suggestions

**Low Priority / Nice-to-Have:**
- Polish and minor optimizations
- Style improvements and code cleanup

For each suggestion:
1. Explain the current approach and why it could be improved
2. Provide specific, actionable recommendations with code examples
3. Explain the benefits of the change
4. Consider and mention any trade-offs

### ❓ Questions & Clarifications
(Only if needed) Ask about:
- Unclear intent or design decisions
- Missing context that would affect the review
- Specific requirements or constraints not evident from the code

## Review Principles

- **Be constructive**: Frame feedback positively and focus on improvement
- **Be specific**: Vague advice like "improve readability" is unhelpful; show exactly what and how
- **Prioritize**: Not all issues are equal; help developers focus on what matters most
- **Provide context**: Explain *why* something is a best practice, not just *what* to change
- **Consider trade-offs**: Acknowledge when recommendations involve trade-offs (performance vs. readability, etc.)
- **Be pragmatic**: Perfect is the enemy of good; balance idealism with practical constraints
- **Teach, don't just correct**: Help developers understand principles, not just fix this instance
- **Use code examples**: Show, don't just tell. Provide concrete before/after examples
- **Reference line numbers**: Always include file:line references for specific issues

## Critical Reminders

- DO NOT invent issues that don't exist just to fill sections
- If there are no critical issues, say "No critical issues found"
- Focus on actionable feedback over theoretical perfection
- Consider the project context and constraints
- Prioritize issues that have real impact over nitpicks
- Be thorough but concise - developers are busy

Begin your review now with the exact format specified above.`;
}

export function createReviewCommand(): Command {
  const command = new Command('review');

  command
    .description('Review code for issues and improvements')
    .argument('[path]', 'Path to review (file or directory)', '.')
    .option('-n, --num-files <number>', 'Maximum number of files to review', '15')
    .option('-a, --all', 'Review all files (no limit)')
    .action(async (path: string, options: { numFiles?: string; all?: boolean }) => {
      try {
        const config = loadConfig();

        if (config.contextEmbedding?.enabled) {
          const { ProjectContextManager } = await import('../context/manager.js');
          ProjectContextManager.getInstance().configureEmbeddings({
            enabled: true,
            dimensions: config.contextEmbedding.dimensions,
            maxFileSize: config.contextEmbedding.maxFileSize,
          });
        }
        
        console.log(chalk.blue(`Reviewing: ${path}`));
        
        // Show file collection spinner
        const fileSpinner = ora({
          text: chalk.blue('Collecting files...'),
          spinner: 'dots',
          color: 'blue'
        }).start();
        
        // Collect files to review
        const files = collectFilesToReview(path);
        
        if (files.length === 0) {
          fileSpinner.fail(chalk.red('No supported files found to review.'));
          return;
        }
        
        fileSpinner.text = chalk.blue(`Found ${files.length} files to review`);

        // Determine file limit
        const maxFiles = options.all ? files.length : parseInt(options.numFiles || '15', 10);
        const filesToReview = files.slice(0, maxFiles);

        if (files.length > maxFiles && !options.all) {
          fileSpinner.info(chalk.yellow(`Reviewing first ${maxFiles} of ${files.length} files. Use --all to review all files.`));
        }

        // Read file contents
        const fileContents: string[] = [];
        for (const file of filesToReview) {
          try {
            const content = readFileSync(file, 'utf-8');
            if (!isBinaryContent(content)) {
              fileContents.push(`File: ${file}\n${content}`);
            }
          } catch (error) {
            console.warn(chalk.yellow(`Could not read ${file}: ${error}`));
          }
        }
        
        if (fileContents.length === 0) {
          fileSpinner.fail(chalk.red('No readable files found to review.'));
          return;
        }
        
        fileSpinner.succeed(chalk.green(`Analyzing ${fileContents.length} files`));
        
        const context = fileContents.join('\n\n---\n\n');
        const dominantLanguage = detectLanguageFromPath(files);

        const systemPrompt = buildReviewSystemPrompt(dominantLanguage);

        const messages: ChatMessage[] = [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: `Please review this code:\n\n${context}`
          }
        ];
        
        // Show analysis spinner
        const analysisSpinner = ora({
          text: chalk.blue('AI is analyzing code...'),
          spinner: 'dots',
          color: 'blue'
        }).start();

        // Simulate analysis time
        await new Promise(resolve => setTimeout(resolve, 1000));
        analysisSpinner.stop();

        // Stream the response with formatting
        console.log(chalk.bold.cyan('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
        console.log(chalk.bold.green('  🔍 CODE REVIEW REPORT'));
        console.log(chalk.bold.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

        // Show thinking indicator until first response
        const thinkingSpinner = ora({
          text: chalk.blue('Generating comprehensive review...'),
          spinner: 'dots',
          color: 'blue'
        }).start();

        let isFirstChunk = true;
        let hasStarted = false;
        const formatter = new ReviewFormatter();

        let streamedResponse = '';
        for await (const chunk of config.provider.stream(messages)) {
          if (isFirstChunk && !hasStarted) {
            // Stop thinking spinner when first chunk arrives
            thinkingSpinner.stop();
            hasStarted = true;
          }
          if (isFirstChunk) {
            isFirstChunk = false;
          }
          streamedResponse += chunk;

          // Apply color formatting as we stream (line by line)
          const formattedChunk = formatter.formatChunk(chunk);
          process.stdout.write(formattedChunk);
        }

        // Flush any remaining buffer
        const remaining = formatter.flush();
        if (remaining) {
          process.stdout.write(remaining);
        }

        // Make sure spinner is stopped
        if (!hasStarted) {
          thinkingSpinner.stop();
        }

        // Add closing line
        console.log(chalk.bold.cyan('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));

        if (!streamedResponse.trim()) {
          try {
            const fallback = await config.provider.chat(messages);
            console.log(fallback);
          } catch (fallbackError) {
            console.log(
              chalk.red(
                `\n❌ Unable to retrieve review: ${
                  fallbackError instanceof Error
                    ? fallbackError.message
                    : String(fallbackError)
                }`
              )
            );
          }
        }

        console.log('\n');

      } catch (error) {
        console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });
  
  return command;
}

function collectFilesToReview(path: string): string[] {
  const files: string[] = [];
  
  try {
    if (existsSync(path)) {
      const stats = statSync(path);
      
      if (stats.isFile()) {
        // Single file
        const ext = extname(path).toLowerCase();
        if (SUPPORTED_EXTENSIONS.has(ext)) {
          files.push(path);
        }
      } else if (stats.isDirectory()) {
        // Directory - find all supported files
        const pattern = '**/*';
        const foundFiles = glob.sync(pattern, {
          cwd: path,
          ignore: [
            '**/.git/**',
            '**/node_modules/**',
            '**/.next/**',
            '**/dist/**',
            '**/build/**',
            '**/.venv/**',
            '**/.turbo/**',
            '**/coverage/**',
            '**/.cache/**',
            '**/target/**',
            '**/vendor/**'
          ],
          nodir: true
        });
        
        for (const file of foundFiles) {
          const fullPath = join(path, file);
          const ext = extname(file).toLowerCase();
          if (SUPPORTED_EXTENSIONS.has(ext)) {
            files.push(fullPath);
          }
        }
      }
    }
  } catch (error) {
    console.warn(chalk.yellow(`Error collecting files: ${error}`));
  }
  
  return files;
}

function isBinaryContent(content: string): boolean {
  if (content.includes('\0')) return true;
  
  const printableChars = content.replace(/[\x20-\x7E\s]/g, '').length;
  const totalChars = content.length;
  
  return totalChars > 0 && printableChars / totalChars > 0.3;
}
