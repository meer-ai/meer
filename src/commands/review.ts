import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { readFileSync, existsSync, statSync, writeFileSync } from 'fs';
import { join, extname } from 'path';
import { glob } from 'glob';
import inquirer from 'inquirer';
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

interface ReviewIssue {
  title: string;
  location: string;
  impact?: string;
  recommendation?: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  category: string;
}

class ReviewFormatter {
  private buffer = '';
  private inCodeBlock = false;
  private fullText = ''; // Store full review text for parsing

  getFullText(): string {
    return this.fullText;
  }

  formatChunk(chunk: string): string {
    this.buffer += chunk;
    this.fullText += chunk; // Store unformatted text
    const lines = this.buffer.split('\n');

    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() || '';

    // Format complete lines
    const formattedLines = lines.map(line => this.formatLine(line));
    return formattedLines.join('\n') + (formattedLines.length > 0 ? '\n' : '');
  }

  flush(): string {
    if (this.buffer) {
      this.fullText += this.buffer; // Add remaining buffer to full text
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
    if (line.includes('### 📊 Overview') || line.includes('###📊 Overview')) {
      formatted = formatted.replace(/###\s*📊\s*Overview/g, '📊 Overview');
      return '\n' + chalk.bold.blue(formatted);
    }
    if (line.includes('### ✅ Strengths') || line.includes('###✅ Strengths')) {
      formatted = formatted.replace(/###\s*✅\s*Strengths/g, '✅ Strengths');
      return '\n' + chalk.bold.green(formatted);
    }
    if (line.includes('### 🚨 Critical Issues') || line.includes('###🚨 Critical Issues')) {
      formatted = formatted.replace(/###\s*🚨\s*Critical Issues/g, '🚨 Critical Issues');
      return '\n' + chalk.bold.red(formatted);
    }
    if (line.includes('### 💡 Improvement Opportunities') || line.includes('###💡 Improvement Opportunities')) {
      formatted = formatted.replace(/###\s*💡\s*Improvement Opportunities/g, '💡 Improvement Opportunities');
      return '\n' + chalk.bold.yellow(formatted);
    }
    if (line.includes('### ❓ Questions') || line.includes('###❓ Questions')) {
      formatted = formatted.replace(/###\s*❓\s*Questions/g, '❓ Questions');
      return '\n' + chalk.bold.magenta(formatted);
    }

    // Priority levels - remove ** and use colors/bold
    formatted = formatted.replace(/\*\*High Priority:\*\*/g, chalk.bold.red('⚠️  HIGH PRIORITY:'));
    formatted = formatted.replace(/\*\*Medium Priority:\*\*/g, chalk.bold.yellow('⚡ MEDIUM PRIORITY:'));
    formatted = formatted.replace(/\*\*Low Priority[^:]*:\*\*/g, chalk.bold.cyan('💡 LOW PRIORITY:'));

    // Critical issue components - remove ** and apply colors
    formatted = formatted.replace(/\*\*\[([^\]]+)\]\*\*:/g, chalk.bold.red('[$1]') + chalk.white(':'));
    formatted = formatted.replace(/- \*\*Location\*\*:/g, chalk.gray('  📍 ') + chalk.bold('Location:'));
    formatted = formatted.replace(/- \*\*Impact\*\*:/g, chalk.red('  ⚡ ') + chalk.bold('Impact:'));
    formatted = formatted.replace(/- \*\*Recommendation\*\*:/g, chalk.green('  ✅ ') + chalk.bold('Fix:'));

    // File:line references
    formatted = formatted.replace(
      /(\w+\.(ts|tsx|js|jsx|py|go|rs|java|kt|rb|php|sql|sh|css|html|vue|svelte|c|cpp|h|hpp)):(\d+)/g,
      chalk.cyan('$1') + chalk.gray(':') + chalk.yellow('$3')
    );

    // Bullet points
    if (/^- /.test(line)) {
      formatted = formatted.replace(/^- /, chalk.blue('  • '));
    }

    // Inline code - keep backticks but color them
    formatted = formatted.replace(/`([^`]+)`/g, (_, code) => chalk.cyan.bold(`\`${code}\``));

    // Bold text - remove ** markers and apply ANSI bold
    // Process from inside out to handle nested formatting
    while (/\*\*([^*]+)\*\*/.test(formatted)) {
      formatted = formatted.replace(/\*\*([^*]+)\*\*/g, (match, text) => {
        // Check if already colored, if not apply bold
        if (match.includes('\x1b[')) {
          return text; // Already has ANSI codes
        }
        return chalk.bold(text);
      });
    }

    return formatted;
  }
}

function parseReviewIssues(reviewText: string): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  const lines = reviewText.split('\n');

  let currentPriority: 'critical' | 'high' | 'medium' | 'low' | null = null;
  let currentCategory = '';
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    // Detect priority sections
    if (line.includes('🚨 Critical Issues') || line.includes('Critical Issues')) {
      currentPriority = 'critical';
      i++;
      continue;
    }
    if (line.includes('High Priority') || line.includes('HIGH PRIORITY')) {
      currentPriority = 'high';
      i++;
      continue;
    }
    if (line.includes('Medium Priority') || line.includes('MEDIUM PRIORITY')) {
      currentPriority = 'medium';
      i++;
      continue;
    }
    if (line.includes('Low Priority') || line.includes('LOW PRIORITY')) {
      currentPriority = 'low';
      i++;
      continue;
    }

    // Parse issue blocks (format: **[Category]**: description)
    const categoryMatch = line.match(/\*\*\[([^\]]+)\]\*\*:|^\[([^\]]+)\]:/);
    if (categoryMatch && currentPriority) {
      currentCategory = categoryMatch[1] || categoryMatch[2];
      const title = line.split(/\*\*:|:/).slice(1).join(':').trim();

      // Look ahead for Location, Impact, Recommendation
      let location = '';
      let impact = '';
      let recommendation = '';

      for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
        const nextLine = lines[j].trim();

        if (nextLine.match(/\*\*Location\*\*:|Location:/)) {
          location = nextLine.split(/\*\*:|:/).slice(1).join(':').trim();
        }
        if (nextLine.match(/\*\*Impact\*\*:|Impact:/)) {
          impact = nextLine.split(/\*\*:|:/).slice(1).join(':').trim();
        }
        if (nextLine.match(/\*\*Recommendation\*\*:|Fix:/)) {
          recommendation = nextLine.split(/\*\*:|:/).slice(1).join(':').trim();
        }

        // Stop if we hit another issue or section
        if (nextLine.match(/\*\*\[|^\[|###|High Priority|Medium Priority|Low Priority/)) {
          break;
        }
      }

      if (location) {
        issues.push({
          title: title || currentCategory,
          location,
          impact,
          recommendation,
          priority: currentPriority,
          category: currentCategory
        });
      }
    }

    i++;
  }

  return issues;
}

async function applyFix(issue: ReviewIssue, fileContents: Map<string, string>): Promise<void> {
  const config = loadConfig();

  // Parse location (format: filename.ext:line)
  const locationMatch = issue.location.match(/([^:]+):(\d+)/);
  if (!locationMatch) {
    console.log(chalk.red('  ✗ Could not parse file location'));
    return;
  }

  const [, filename, lineNumber] = locationMatch;

  // Find the file in the review context
  let fileContent = fileContents.get(filename);
  if (!fileContent) {
    // Try to find by partial match
    for (const [path, content] of fileContents.entries()) {
      if (path.endsWith(filename)) {
        fileContent = content;
        break;
      }
    }
  }

  if (!fileContent) {
    console.log(chalk.red(`  ✗ File not found: ${filename}`));
    return;
  }

  const fixSpinner = ora({
    text: chalk.blue('Generating fix...'),
    spinner: 'dots',
    color: 'blue'
  }).start();

  // Generate fix using AI
  const fixPrompt = `You are a code fixing assistant. Given a code issue, generate ONLY the fixed code snippet.

**Issue**: ${issue.title}
**Category**: ${issue.category}
**Location**: ${issue.location}
${issue.impact ? `**Impact**: ${issue.impact}` : ''}
${issue.recommendation ? `**Recommendation**: ${issue.recommendation}` : ''}

**Current Code**:
\`\`\`
${fileContent}
\`\`\`

Please provide ONLY the complete fixed version of the file. Do not include explanations, just the code.
Format your response as:
\`\`\`
[fixed code here]
\`\`\``;

  try {
    const messages: ChatMessage[] = [
      { role: 'user', content: fixPrompt }
    ];

    const fixedCode = await config.provider.chat(messages);
    fixSpinner.stop();

    // Extract code from markdown code block
    const codeMatch = fixedCode.match(/```[\w]*\n([\s\S]+?)\n```/);
    const extractedCode = codeMatch ? codeMatch[1] : fixedCode.trim();

    // Show diff preview
    console.log(chalk.cyan('\n  Preview of changes:'));
    console.log(chalk.dim('  ─────────────────────────────────────'));

    const originalLines = fileContent.split('\n');
    const fixedLines = extractedCode.split('\n');
    const contextLines = 3;
    const targetLine = parseInt(lineNumber) - 1;

    const startLine = Math.max(0, targetLine - contextLines);
    const endLine = Math.min(originalLines.length, targetLine + contextLines + 1);

    for (let i = startLine; i < endLine; i++) {
      if (i === targetLine) {
        if (originalLines[i] !== fixedLines[i]) {
          console.log(chalk.red(`  - ${originalLines[i]}`));
          console.log(chalk.green(`  + ${fixedLines[i] || ''}`));
        } else {
          console.log(chalk.gray(`    ${originalLines[i]}`));
        }
      } else {
        console.log(chalk.gray(`    ${originalLines[i]}`));
      }
    }
    console.log(chalk.dim('  ─────────────────────────────────────\n'));

    // Confirm application
    const { confirmFix } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirmFix',
        message: 'Apply this fix?',
        default: true
      }
    ]);

    if (confirmFix) {
      // Find the actual file path
      let actualPath = filename;
      for (const [path] of fileContents.entries()) {
        if (path.endsWith(filename)) {
          actualPath = path;
          break;
        }
      }

      writeFileSync(actualPath, extractedCode, 'utf-8');
      console.log(chalk.green(`  ✓ Fix applied to ${filename}`));
    } else {
      console.log(chalk.yellow('  ⊘ Fix cancelled'));
    }

  } catch (error) {
    fixSpinner.fail(chalk.red('Failed to generate fix'));
    console.error(chalk.red(`  Error: ${error instanceof Error ? error.message : String(error)}`));
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
        const fileContentsMap = new Map<string, string>(); // For fix application
        for (const file of filesToReview) {
          try {
            const content = readFileSync(file, 'utf-8');
            if (!isBinaryContent(content)) {
              fileContents.push(`File: ${file}\n${content}`);
              fileContentsMap.set(file, content);
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

        // Parse issues and offer to fix them
        const reviewText = formatter.getFullText();
        const issues = parseReviewIssues(reviewText);

        if (issues.length > 0) {
          console.log(chalk.bold.cyan('🔧 Fixable Issues Found\n'));

          const { shouldFix } = await inquirer.prompt([
            {
              type: 'confirm',
              name: 'shouldFix',
              message: `Found ${issues.length} issue${issues.length > 1 ? 's' : ''} with location info. Would you like to apply fixes?`,
              default: true
            }
          ]);

          if (shouldFix) {
            // Let user select which issues to fix
            const choices = issues.map((issue, idx) => {
              const priorityIcon = {
                critical: '🔴',
                high: '🟠',
                medium: '🟡',
                low: '🟢'
              }[issue.priority];

              return {
                name: `${priorityIcon} [${issue.category}] ${issue.title} (${issue.location})`,
                value: idx,
                short: issue.title
              };
            });

            const { selectedIssues } = await inquirer.prompt([
              {
                type: 'checkbox',
                name: 'selectedIssues',
                message: 'Select issues to fix:',
                choices,
                pageSize: 10
              }
            ]);

            if (selectedIssues.length > 0) {
              console.log(chalk.cyan(`\nApplying ${selectedIssues.length} fix${selectedIssues.length > 1 ? 'es' : ''}...\n`));

              for (const idx of selectedIssues) {
                const issue = issues[idx];
                console.log(chalk.bold.white(`\n📍 Fixing: ${issue.title}`));
                console.log(chalk.gray(`   Location: ${issue.location}`));

                await applyFix(issue, fileContentsMap);
              }

              console.log(chalk.bold.green('\n✓ All selected fixes processed!\n'));
            } else {
              console.log(chalk.yellow('\nNo fixes selected.\n'));
            }
          }
        }

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
