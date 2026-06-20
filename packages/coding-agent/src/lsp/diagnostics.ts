import ts from 'typescript';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';

export interface Diagnostic {
  line: number;
  column: number;
  message: string;
  severity: 'error' | 'warning' | 'info';
}

export interface ValidationResult {
  valid: boolean;
  errors: Diagnostic[];
}

/**
 * Validate TypeScript/JavaScript code using TypeScript compiler API
 */
export function validateTypeScript(
  filepath: string,
  content: string,
  cwd: string
): ValidationResult {
  const diagnostics: Diagnostic[] = [];

  try {
    // Create a virtual source file
    const sourceFile = ts.createSourceFile(
      filepath,
      content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX // Support both TS and TSX
    );

    // Get syntactic diagnostics (parsing errors)
    const syntacticDiagnostics = (sourceFile as any).parseDiagnostics || [];

    for (const diag of syntacticDiagnostics) {
      if (diag.start !== undefined) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(diag.start);
        diagnostics.push({
          line: line + 1,
          column: character + 1,
          message: ts.flattenDiagnosticMessageText(diag.messageText, '\n'),
          severity: diag.category === ts.DiagnosticCategory.Error ? 'error' : 'warning',
        });
      }
    }

    // Try to get semantic diagnostics if tsconfig.json exists
    const tsconfigPath = findTsConfig(cwd);
    if (tsconfigPath && existsSync(tsconfigPath)) {
      const semanticDiagnostics = getSemanticDiagnostics(filepath, content, tsconfigPath);
      diagnostics.push(...semanticDiagnostics);
    }

    const hasErrors = diagnostics.some(d => d.severity === 'error');

    return {
      valid: !hasErrors,
      errors: diagnostics,
    };
  } catch (error) {
    // Fallback to basic validation
    return {
      valid: false,
      errors: [{
        line: 1,
        column: 1,
        message: error instanceof Error ? error.message : String(error),
        severity: 'error',
      }],
    };
  }
}

/**
 * Get semantic diagnostics using TypeScript compiler API
 */
function getSemanticDiagnostics(
  filepath: string,
  content: string,
  tsconfigPath: string
): Diagnostic[] {
  try {
    const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (configFile.error) {
      return [];
    }

    const parsedConfig = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      dirname(tsconfigPath)
    );

    // Create a temporary program with the modified file
    const host = ts.createCompilerHost(parsedConfig.options);
    const originalGetSourceFile = host.getSourceFile;

    host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
      // Use our modified content for the target file
      if (fileName === filepath) {
        return ts.createSourceFile(fileName, content, languageVersion, true);
      }
      return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    };

    const program = ts.createProgram([filepath], parsedConfig.options, host);
    const sourceFile = program.getSourceFile(filepath);

    if (!sourceFile) {
      return [];
    }

    const semanticDiagnostics = program.getSemanticDiagnostics(sourceFile);
    const diagnostics: Diagnostic[] = [];

    for (const diag of semanticDiagnostics.slice(0, 10)) { // Limit to 10 for performance
      if (diag.start !== undefined && diag.file) {
        const { line, character } = diag.file.getLineAndCharacterOfPosition(diag.start);
        diagnostics.push({
          line: line + 1,
          column: character + 1,
          message: ts.flattenDiagnosticMessageText(diag.messageText, '\n'),
          severity: diag.category === ts.DiagnosticCategory.Error ? 'error' : 'warning',
        });
      }
    }

    return diagnostics;
  } catch (error) {
    // Semantic diagnostics are best-effort
    return [];
  }
}

/**
 * Find tsconfig.json in the project directory or parent directories
 */
function findTsConfig(cwd: string): string | null {
  let currentDir = cwd;
  const root = '/';

  while (currentDir !== root) {
    const tsconfigPath = join(currentDir, 'tsconfig.json');
    if (existsSync(tsconfigPath)) {
      return tsconfigPath;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  return null;
}

/**
 * Validate Python code (basic heuristics)
 */
export function validatePython(content: string): ValidationResult {
  const errors: Diagnostic[] = [];
  const lines = content.split('\n');

  // Check for basic syntax issues
  const invalidPatterns = [
    { pattern: /^\s*(def|class)\s*$/, message: 'Incomplete function/class definition' },
    { pattern: /^\s*if\s*:/, message: 'Empty if condition' },
    { pattern: /^\s*elif\s*:/, message: 'Empty elif condition' },
    { pattern: /^\s*while\s*:/, message: 'Empty while condition' },
    { pattern: /^\s*for\s*:/, message: 'Empty for condition' },
  ];

  lines.forEach((line, index) => {
    for (const check of invalidPatterns) {
      if (check.pattern.test(line)) {
        errors.push({
          line: index + 1,
          column: 1,
          message: check.message,
          severity: 'error',
        });
      }
    }
  });

  // Check indentation consistency (tabs vs spaces mixing)
  let usesSpaces: boolean | null = null;
  let usesTabs: boolean | null = null;

  lines.forEach((line, index) => {
    if (line.startsWith(' ')) {
      usesSpaces = true;
    } else if (line.startsWith('\t')) {
      usesTabs = true;
    }

    if (usesSpaces && usesTabs) {
      errors.push({
        line: index + 1,
        column: 1,
        message: 'Inconsistent indentation (mixing tabs and spaces)',
        severity: 'warning',
      });
    }
  });

  return {
    valid: errors.filter(e => e.severity === 'error').length === 0,
    errors,
  };
}

/**
 * Main validation function that routes to the appropriate validator
 */
export function validateSyntax(
  filepath: string,
  content: string,
  cwd: string
): { valid: boolean; errors: string[] } {
  const ext = filepath.toLowerCase();

  // TypeScript/JavaScript
  if (/\.(ts|tsx|js|jsx)$/.test(ext)) {
    const result = validateTypeScript(filepath, content, cwd);
    return {
      valid: result.valid,
      errors: result.errors.map(e => `Line ${e.line}:${e.column} - ${e.message}`),
    };
  }

  // Python
  if (/\.py$/.test(ext)) {
    const result = validatePython(content);
    return {
      valid: result.valid,
      errors: result.errors.map(e => `Line ${e.line}:${e.column} - ${e.message}`),
    };
  }

  // Other languages - no validation (assume valid)
  return { valid: true, errors: [] };
}

/**
 * Check if a file type supports syntax validation
 */
export function isValidatableFile(filepath: string): boolean {
  return /\.(ts|tsx|js|jsx|py)$/.test(filepath.toLowerCase());
}
