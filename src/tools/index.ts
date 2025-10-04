import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, relative, dirname } from 'path';
import chalk from 'chalk';

export interface ToolResult {
  tool: string;
  result: string;
  error?: string;
}

export interface FileEdit {
  path: string;
  oldContent: string;
  newContent: string;
  description: string;
}

/**
 * Tool: Read a file from the project
 */
export function readFile(filepath: string, cwd: string): ToolResult {
  try {
    const fullPath = join(cwd, filepath);

    if (!existsSync(fullPath)) {
      return {
        tool: 'read_file',
        result: `File not found: ${filepath}\n\nNote: This file does not exist yet. If you want to create it, use propose_edit with the new file content.`,
        error: undefined  // Don't mark as error - this is expected for new files
      };
    }

    const content = readFileSync(fullPath, 'utf-8');
    const lines = content.split('\n').length;

    return {
      tool: 'read_file',
      result: `File: ${filepath} (${lines} lines)\n\n${content}`
    };
  } catch (error) {
    return {
      tool: 'read_file',
      result: '',
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Tool: List files in a directory
 */
export function listFiles(dirpath: string, cwd: string): ToolResult {
  try {
    const fullPath = dirpath ? join(cwd, dirpath) : cwd;

    if (!existsSync(fullPath)) {
      return {
        tool: 'list_files',
        result: '',
        error: `Directory not found: ${dirpath || '.'}`
      };
    }

    const items = readdirSync(fullPath);
    const files: string[] = [];
    const dirs: string[] = [];

    for (const item of items) {
      const itemPath = join(fullPath, item);
      try {
        const stats = statSync(itemPath);
        if (stats.isDirectory()) {
          dirs.push(item + '/');
        } else {
          const size = stats.size;
          files.push(`${item} (${formatBytes(size)})`);
        }
      } catch {
        // Skip items that can't be accessed
      }
    }

    const result = [...dirs.sort(), ...files.sort()].join('\n');

    return {
      tool: 'list_files',
      result: `Directory: ${dirpath || '.'}\n\n${result}`
    };
  } catch (error) {
    return {
      tool: 'list_files',
      result: '',
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Tool: Propose a file edit (doesn't apply it yet)
 */
export function proposeEdit(filepath: string, newContent: string, description: string, cwd: string): FileEdit {
  const fullPath = join(cwd, filepath);
  const oldContent = existsSync(fullPath) ? readFileSync(fullPath, 'utf-8') : '';

  return {
    path: filepath,
    oldContent,
    newContent,
    description
  };
}

/**
 * Apply an approved edit
 */
export function applyEdit(edit: FileEdit, cwd: string): ToolResult {
  try {
    const fullPath = join(cwd, edit.path);
    const dir = dirname(fullPath);

    // Ensure directory exists
    if (!existsSync(dir)) {
      const { mkdirSync } = require('fs');
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(fullPath, edit.newContent, 'utf-8');

    return {
      tool: 'apply_edit',
      result: `Successfully updated ${edit.path}`
    };
  } catch (error) {
    return {
      tool: 'apply_edit',
      result: '',
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Generate a colored diff between old and new content
 */
export function generateDiff(oldContent: string, newContent: string): string[] {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const diff: string[] = [];

  const maxLen = Math.max(oldLines.length, newLines.length);

  for (let i = 0; i < maxLen; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];

    if (oldLine !== newLine) {
      if (oldLine !== undefined) {
        diff.push(chalk.red(`- ${oldLine}`));
      }
      if (newLine !== undefined) {
        diff.push(chalk.green(`+ ${newLine}`));
      }
    } else if (diff.length > 0 && diff.length < 50) {
      // Show context lines
      diff.push(chalk.gray(`  ${oldLine}`));
    }
  }

  return diff;
}

/**
 * Parse tool calls from AI response
 * Expected format: <tool name="tool_name" param1="value1">content</tool>
 */
export function parseToolCalls(response: string): Array<{ tool: string; params: Record<string, string>; content: string }> {
  const tools: Array<{ tool: string; params: Record<string, string>; content: string }> = [];

  // First try standard format with closing tags
  const toolRegex = /<tool\s+name="([^"]+)"([^>]*)>([\s\S]*?)<\/tool>/gi;

  let match;
  while ((match = toolRegex.exec(response)) !== null) {
    const [fullMatch, toolName, paramsStr, content] = match;

    // Parse parameters
    const params: Record<string, string> = {};
    const paramRegex = /(\w+)="([^"]*)"/g;
    let paramMatch;
    while ((paramMatch = paramRegex.exec(paramsStr)) !== null) {
      params[paramMatch[1]] = paramMatch[2];
    }

    // Debug logging
    if (toolName === 'propose_edit' && !content.trim()) {
      console.log(chalk.yellow(`\n⚠️  Warning: propose_edit has empty content`));
      console.log(chalk.gray(`Full match: ${fullMatch.substring(0, 200)}...`));
    }

    tools.push({
      tool: toolName,
      params,
      content: content.trim()
    });
  }

  // Also handle self-closing tags (though they shouldn't have content)
  const selfClosingRegex = /<tool\s+name="([^"]+)"([^>]*)\/>/gi;
  while ((match = selfClosingRegex.exec(response)) !== null) {
    const [, toolName, paramsStr] = match;

    // Parse parameters
    const params: Record<string, string> = {};
    const paramRegex = /(\w+)="([^"]*)"/g;
    let paramMatch;
    while ((paramMatch = paramRegex.exec(paramsStr)) !== null) {
      params[paramMatch[1]] = paramMatch[2];
    }

    tools.push({
      tool: toolName,
      params,
      content: ''
    });
  }

  return tools;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
