/**
 * Static risk classification for shell commands.
 *
 * Tiers (most to least restrictive):
 *   - "catastrophic": system-destroying, essentially never legitimate from an
 *     agent → hard-denied regardless of trust/approvals/allowlist.
 *   - "dangerous": risky but recoverable/legitimate (force-push, rm -rf <path>,
 *     pipe-to-shell) → ALWAYS prompt, even in a trusted project with approvals
 *     off; never remembered; denied when no interactive prompt is available.
 *   - "safe": read-only or common dev-workflow commands → auto-approved.
 *   - "normal": everything else → governed by trust mode + approvals + allowlist.
 */

export type CommandRisk = "catastrophic" | "dangerous" | "safe" | "normal";

const CATASTROPHIC_PATTERNS: RegExp[] = [
  /\bmkfs\b/i,
  /\bdd\b[^\n]*\bof=\/dev\//i,
  /\bformat\s+(c:|\/dev\/)/i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /\binit\s+0\b/i,
  // rm -rf targeting a filesystem root / home (/, /*, ~, --no-preserve-root /)
  /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+(--[a-z-]+\s+)*(\/|~|\/\*)(\s|$)/i,
  />\s*\/dev\/(sd|nvme|disk|hd)/i,
];

const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+-[a-z]*r[a-z]*f|rm\s+-[a-z]*f[a-z]*r/i, // rm -rf <path>
  /\bsudo\s+rm\b/i,
  /\bgit\s+push\b[^\n]*\s-(?:-force(?:-with-lease)?|f)\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bchmod\s+(-R\s+)?(777|a\+rwx)\b/i,
  /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i, // pipe-to-shell
  /\b(npm|yarn|pnpm)\s+publish\b/i, // outward-facing, hard to undo
  /\bdel\s+\/[sf]/i,
  /\brd\s+\/s/i,
];

const SAFE_PATTERNS: RegExp[] = [
  // git — read-only operations
  /^git\s+(status|diff|log|branch|show|describe|rev-parse|shortlog|tag|ls-files|ls-remote|blame|stash list|remote|fetch\s+--dry-run|config\s+--list|reflog|cherry|check-ignore)/i,
  // npm — build, test, info, audit, listing
  /^npm\s+(run|test|build|install|i|ci|audit|ls|list|outdated|info|view|pack|version|help|fund|ping|prefix|bin)(\s|$)/i,
  // yarn — build, test, info, audit
  /^yarn(\s+(run|test|build|install|audit|list|outdated|info|versions|check|help|why|licenses|bin|config))?(\s|$)/i,
  // pnpm — build, test, info, audit
  /^pnpm\s+(run|test|build|install|audit|list|ls|outdated|info|why|licenses)(\s|$)/i,
  // npx for common read/check tools
  /^npx\s+(tsc|eslint|prettier|jest|vitest|mocha|ts-node|tsx|vite build|next build|nuxt build|rollup|esbuild|swc|turbo)(\s|$)/i,
  // runtime version / help queries
  /^(node|npm|npx|yarn|pnpm|bun|deno|go|python3?|ruby|java|rustc|cargo)\s+(--version|-v|--help|-h|version)(\s|$)/i,
  // OS read-only
  /^(ls|dir|cat|head|tail|grep|rg|find|fd|bat|less|more|type)\s/i,
  /^(ls|dir|pwd|echo|printf|env|whoami|hostname|uname|date|which|where|type)(\s|$)/i,
  // package.json scripts via node/bun
  /^(node|bun)\s+--?\w/i,
];

/**
 * Classify a shell command into a risk tier. Catastrophic and dangerous tiers
 * take precedence over the safe allowlist (a dangerous flag on an otherwise
 * "safe" base command is still dangerous).
 */
export function classifyCommand(command: string): CommandRisk {
  const cmd = command.trim();
  if (CATASTROPHIC_PATTERNS.some((p) => p.test(cmd))) return "catastrophic";
  if (DANGEROUS_PATTERNS.some((p) => p.test(cmd))) return "dangerous";
  if (SAFE_PATTERNS.some((p) => p.test(cmd))) return "safe";
  return "normal";
}
