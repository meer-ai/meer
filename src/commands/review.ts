import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { readFileSync, existsSync, statSync } from 'fs';
import { join, extname } from 'path';
import { glob } from 'glob';
import { loadConfig } from '../config.js';
import type { ChatMessage } from '../providers/base.js';

const SUPPORTED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.sql', '.md', '.json', '.yaml', '.yml'
]);

export function createReviewCommand(): Command {
  const command = new Command('review');
  
  command
    .description('Review code for issues and improvements')
    .argument('[path]', 'Path to review (file or directory)', '.')
    .action(async (path: string) => {
      try {
        const config = loadConfig();
        
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
        
        // Read file contents
        const fileContents: string[] = [];
        for (const file of files.slice(0, 8)) { // Limit to 8 files
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
        
        const messages: ChatMessage[] = [
          {
            role: 'system',
            content: 'You are an expert code reviewer. Analyze the provided code and identify:\n' +
              '- Correctness issues (bugs, logic errors)\n' +
              '- Performance problems (inefficient algorithms, memory leaks)\n' +
              '- Security vulnerabilities (injection, XSS, etc.)\n' +
              '- Code quality issues (readability, maintainability)\n' +
              '- Best practices violations\n' +
              '- Edge cases not handled\n\n' +
              'Provide concise, actionable feedback. Focus on the most important issues first.\n' +
              'Format as bullet points with specific file/line references when possible.'
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
        
        // Stream the response
        console.log(chalk.green('\n🔍 Code Review:\n'));
        
        // Show thinking indicator until first response
        const thinkingSpinner = ora({
          text: chalk.blue('AI is thinking...'),
          spinner: 'dots',
          color: 'blue'
        }).start();
        
        let isFirstChunk = true;
        let hasStarted = false;
        
        for await (const chunk of config.provider.stream(messages)) {
          if (isFirstChunk && !hasStarted) {
            // Stop thinking spinner when first chunk arrives
            thinkingSpinner.stop();
            hasStarted = true;
            await new Promise(resolve => setTimeout(resolve, 200));
          }
          if (isFirstChunk) {
            isFirstChunk = false;
          }
          process.stdout.write(chunk);
        }
        
        // Make sure spinner is stopped
        if (!hasStarted) {
          thinkingSpinner.stop();
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
