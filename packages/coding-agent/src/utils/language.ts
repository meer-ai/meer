import { extname } from "path";

const EXTENSION_LANG_MAP: Record<string, string> = {
  ".go": "go",
  ".py": "python",
  ".js": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".rb": "ruby",
  ".php": "php",
  ".cs": "csharp",
  ".java": "java",
  ".rs": "rust",
  ".kt": "kotlin",
  ".swift": "swift",
  ".scala": "scala",
  ".dart": "dart",
};

export function detectLanguageFromPath(pathOrPaths: string | string[]): string | undefined {
  const paths = Array.isArray(pathOrPaths) ? pathOrPaths : [pathOrPaths];

  for (const filePath of paths) {
    const ext = extname(filePath).toLowerCase();
    if (EXTENSION_LANG_MAP[ext]) {
      return EXTENSION_LANG_MAP[ext];
    }
  }

  return undefined;
}
