import { existsSync, readFileSync } from 'fs';
import { join, dirname, basename } from 'path';

export class TestDetector {
  constructor(private cwd: string) {}

  /**
   * Find test files related to a source file
   */
  findRelatedTests(filepath: string): string[] {
    const testFiles: string[] = [];
    const dir = dirname(filepath);
    const name = basename(filepath);
    const nameWithoutExt = name.replace(/\.(ts|tsx|js|jsx|py|go|rs)$/, '');

    // Pattern 1: Same directory, .test. or .spec.
    const patterns = [
      join(dir, `${nameWithoutExt}.test.ts`),
      join(dir, `${nameWithoutExt}.test.tsx`),
      join(dir, `${nameWithoutExt}.test.js`),
      join(dir, `${nameWithoutExt}.test.jsx`),
      join(dir, `${nameWithoutExt}.spec.ts`),
      join(dir, `${nameWithoutExt}.spec.tsx`),
      join(dir, `${nameWithoutExt}.spec.js`),
      join(dir, `${nameWithoutExt}.spec.jsx`),
      join(dir, `${nameWithoutExt}_test.py`),
      join(dir, `${nameWithoutExt}_test.go`),
      join(dir, `${nameWithoutExt}_test.rs`),

      // Pattern 2: __tests__ directory
      join(dir, '__tests__', `${nameWithoutExt}.test.ts`),
      join(dir, '__tests__', `${nameWithoutExt}.test.js`),
      join(dir, '__tests__', `${name}`),

      // Pattern 3: tests/ directory (mirror source structure)
      join(this.cwd, 'tests', filepath.replace('src/', '')),
      join(this.cwd, 'test', filepath.replace('src/', '')),

      // Pattern 4: __tests__ at root
      join(this.cwd, '__tests__', filepath),
      join(this.cwd, '__tests__', filepath.replace('.ts', '.test.ts')),
      join(this.cwd, '__tests__', filepath.replace('.js', '.test.js')),
    ];

    for (const pattern of patterns) {
      const fullPath = join(this.cwd, pattern);
      if (existsSync(fullPath)) {
        testFiles.push(pattern);
      }
    }

    return [...new Set(testFiles)]; // Deduplicate
  }

  /**
   * Detect test framework from package.json
   */
  detectFramework(): string | null {
    const packageJsonPath = join(this.cwd, 'package.json');
    if (!existsSync(packageJsonPath)) {
      return null;
    }

    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      const deps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      };

      // Check for JavaScript/TypeScript frameworks
      if (deps.vitest) return 'vitest';
      if (deps.jest) return 'jest';
      if (deps.mocha) return 'mocha';
      if (deps.ava) return 'ava';

      // Check for Python frameworks
      if (deps.pytest) return 'pytest';
      if (deps.unittest) return 'unittest';

      // Check for Go (no npm deps, but might be in workspace)
      const goModPath = join(this.cwd, 'go.mod');
      if (existsSync(goModPath)) return 'go test';

      // Check for Rust (no npm deps, but might be in workspace)
      const cargoPath = join(this.cwd, 'Cargo.toml');
      if (existsSync(cargoPath)) return 'cargo test';

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Get the command to run tests for a specific framework
   */
  getTestCommand(framework: string, testFiles: string[]): string | null {
    const testPaths = testFiles.join(' ');

    switch (framework) {
      case 'jest':
        return `npx jest ${testPaths}`;

      case 'vitest':
        return `npx vitest run ${testPaths}`;

      case 'mocha':
        return `npx mocha ${testPaths}`;

      case 'ava':
        return `npx ava ${testPaths}`;

      case 'pytest':
        return `pytest ${testPaths}`;

      case 'unittest':
        return `python -m unittest ${testPaths.replace(/\//g, '.').replace(/\.py$/, '')}`;

      case 'go test':
        // Go test requires package paths, not file paths
        const uniqueDirs = [...new Set(testFiles.map(f => dirname(f)))];
        return `go test ${uniqueDirs.map(d => `./${d}`).join(' ')}`;

      case 'cargo test':
        return `cargo test`;

      default:
        return null;
    }
  }

  /**
   * Check if a file is a test file
   */
  isTestFile(filepath: string): boolean {
    const name = basename(filepath);
    return /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(name) ||
           /_test\.(py|go|rs)$/.test(name) ||
           filepath.includes('__tests__') ||
           filepath.includes('/tests/') ||
           filepath.includes('/test/');
  }
}
