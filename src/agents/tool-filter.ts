import chalk from "chalk";
import { logVerbose } from "../logger.js";

/**
 * Tool Access Control
 *
 * Manages which tools a sub-agent can access based on its definition.
 * This provides a security layer to prevent agents from using inappropriate tools.
 */

// All available tools in the system
export const ALL_TOOLS = [
  // File operations
  'read_file',
  'list_files',
  'find_files',
  'read_many_files',
  'read_folder',
  'grep',

  // File editing
  'propose_edit',
  'edit_section',
  'edit_line',

  // Command execution
  'run_command',

  // Web/Search
  'google_search',
  'web_fetch',
  'brave_search',

  // Project analysis
  'analyze_project',
  'search_text',

  // Memory
  'save_memory',
  'load_memory',

  // MCP tools are dynamic
  'mcp_*',
] as const;

// Commonly used tool categories
export const TOOL_CATEGORIES = {
  READ_ONLY: [
    'read_file',
    'list_files',
    'find_files',
    'read_many_files',
    'read_folder',
    'grep',
    'search_text',
    'analyze_project',
  ],
  WRITE: [
    'propose_edit',
    'edit_section',
    'edit_line',
  ],
  EXECUTE: [
    'run_command',
  ],
  WEB: [
    'google_search',
    'web_fetch',
    'brave_search',
  ],
  MEMORY: [
    'save_memory',
    'load_memory',
  ],
};

/**
 * ToolFilter - Controls which tools an agent can use
 */
export class ToolFilter {
  private allowedTools: Set<string> | null;
  private agentName: string;

  constructor(allowedTools: string[] | undefined, agentName: string) {
    this.agentName = agentName;

    if (!allowedTools || allowedTools.length === 0) {
      // No restrictions - allow all tools
      this.allowedTools = null;
      logVerbose(chalk.gray(`[ToolFilter ${agentName}] No restrictions - all tools allowed`));
    } else {
      this.allowedTools = new Set(allowedTools);
      logVerbose(chalk.blue(`[ToolFilter ${agentName}] Restricted to: ${allowedTools.join(', ')}`));
    }
  }

  /**
   * Check if a tool is allowed
   */
  isAllowed(toolName: string): boolean {
    // No restrictions - allow everything
    if (this.allowedTools === null) {
      return true;
    }

    // Check exact match
    if (this.allowedTools.has(toolName)) {
      return true;
    }

    // Check if it matches a category (e.g., "mcp_*")
    for (const allowed of this.allowedTools) {
      if (allowed.endsWith('*')) {
        const prefix = allowed.slice(0, -1);
        if (toolName.startsWith(prefix)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Validate a tool call - throws error if not allowed
   */
  validateToolCall(toolName: string): void {
    if (!this.isAllowed(toolName)) {
      const allowed = this.allowedTools ? Array.from(this.allowedTools).join(', ') : 'all';
      throw new Error(
        `Tool "${toolName}" is not allowed for agent "${this.agentName}". ` +
        `Allowed tools: ${allowed}`
      );
    }
  }

  /**
   * Get list of allowed tools
   */
  getAllowedTools(): string[] | null {
    return this.allowedTools ? Array.from(this.allowedTools) : null;
  }

  /**
   * Check if agent has unrestricted access
   */
  isUnrestricted(): boolean {
    return this.allowedTools === null;
  }
}

/**
 * Helper to create tool filters from common categories
 */
export function createToolFilterFromCategories(
  categories: (keyof typeof TOOL_CATEGORIES)[],
  agentName: string
): ToolFilter {
  const tools = categories.flatMap(cat => TOOL_CATEGORIES[cat]);
  return new ToolFilter(tools, agentName);
}
