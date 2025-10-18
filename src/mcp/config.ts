/**
 * MCP Configuration Management
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';
import { execSync } from 'child_process';
import yaml from 'yaml';
import type { MCPConfig, MCPServerConfig } from './types.js';
import chalk from 'chalk';

const DEFAULT_MCP_CONFIG_PATH = join(homedir(), '.meer', 'mcp-config.yaml');

const DEFAULT_FILESYSTEM_ROOT = (() => {
  const projectsPath = join(homedir(), 'projects');
  return existsSync(projectsPath) ? projectsPath : homedir();
})();

/**
 * Default MCP configuration template
 * Production-ready configuration with essential developer tools
 */
const DEFAULT_MCP_CONFIG: MCPConfig = {
  mcpServers: {
    // === Core Development Tools ===

    filesystem: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', DEFAULT_FILESYSTEM_ROOT],
      enabled: true, // Enable by default for file operations
      description: 'Secure file operations with configurable access controls',
      timeout: 30000,
    },

    git: {
      command: 'uvx',
      args: ['mcp-server-git', '--repository', process.cwd()],
      enabled: true, // Enable by default for Git operations
      description: 'Git repository operations (status, diff, commit, log)',
      timeout: 30000,
    },

    github: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: {
        GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN}',
      },
      enabled: false, // Requires API key
      description: 'GitHub API integration (repos, issues, PRs, search)',
      timeout: 30000,
    },

    // === Knowledge & Memory ===

    memory: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
      enabled: true, // Enable by default for persistent memory
      description: 'Knowledge graph-based persistent memory system',
      timeout: 30000,
    },

    // === Web & Content ===

    fetch: {
      command: 'uvx',
      args: ['mcp-server-fetch'],
      enabled: true, // Enable by default for web content fetching
      description: 'Web content fetching and conversion to markdown',
      timeout: 30000,
    },

    brave: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-brave-search'],
      env: {
        BRAVE_API_KEY: '${BRAVE_API_KEY}',
      },
      enabled: false, // Requires API key
      description: 'Web search using Brave Search API (requires API key)',
      timeout: 30000,
    },

    puppeteer: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-puppeteer'],
      enabled: false, // Resource-intensive, enable when needed
      description: 'Browser automation and web scraping',
      timeout: 60000, // Longer timeout for browser operations
    },

    // === Design & Collaboration ===

    slack: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-slack'],
      env: {
        SLACK_BOT_TOKEN: '${SLACK_BOT_TOKEN}',
        SLACK_TEAM_ID: '${SLACK_TEAM_ID}',
      },
      enabled: false, // Requires API tokens
      description: 'Slack integration (channels, messages, users)',
      timeout: 30000,
    },

    'google-drive': {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-gdrive'],
      env: {
        GDRIVE_CLIENT_ID: '${GDRIVE_CLIENT_ID}',
        GDRIVE_CLIENT_SECRET: '${GDRIVE_CLIENT_SECRET}',
        GDRIVE_REDIRECT_URI: '${GDRIVE_REDIRECT_URI}',
      },
      enabled: false, // Requires OAuth setup
      description: 'Google Drive file access and management',
      timeout: 30000,
    },

    // === Database & Data ===

    postgres: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-postgres'],
      env: {
        POSTGRES_CONNECTION_STRING: '${POSTGRES_CONNECTION_STRING}',
      },
      enabled: false, // Requires database connection
      description: 'PostgreSQL database queries and schema inspection',
      timeout: 30000,
    },

    sqlite: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sqlite', '--db-path', '${SQLITE_DB_PATH}'],
      enabled: false, // Requires database path
      description: 'SQLite database operations',
      timeout: 30000,
    },

    // === Utilities ===

    time: {
      command: 'uvx',
      args: ['mcp-server-time'],
      enabled: true, // Lightweight utility, enable by default
      description: 'Time and timezone conversion capabilities',
      timeout: 10000,
    },

    sequential_thinking: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
      enabled: false, // Advanced feature, opt-in
      description: 'Dynamic problem-solving through thought sequences',
      timeout: 30000,
    },
  },
  mcp: {
    autoStart: true, // Auto-connect to enabled servers on startup
    timeout: 30000,
    maxRetries: 3,
    cacheTools: true,
    logLevel: 'info',
  },
};

/**
 * Load MCP configuration from file
 */
export function loadMCPConfig(configPath?: string): MCPConfig {
  const path = configPath || DEFAULT_MCP_CONFIG_PATH;

  // If config doesn't exist, create default
  if (!existsSync(path)) {
    console.log(chalk.gray('No MCP config found, creating default...'));
    saveMCPConfig(DEFAULT_MCP_CONFIG, path);
    return DEFAULT_MCP_CONFIG;
  }

  try {
    const content = readFileSync(path, 'utf-8');
    const config = yaml.parse(content) as MCPConfig;

    // Validate and merge with defaults
    return {
      ...DEFAULT_MCP_CONFIG,
      ...config,
      mcp: {
        ...DEFAULT_MCP_CONFIG.mcp,
        ...config.mcp,
      },
    };
  } catch (error) {
    console.error(chalk.red('Failed to load MCP config:'), error);
    return DEFAULT_MCP_CONFIG;
  }
}

/**
 * Save MCP configuration to file
 */
export function saveMCPConfig(config: MCPConfig, configPath?: string): void {
  const path = configPath || DEFAULT_MCP_CONFIG_PATH;

  try {
    // Ensure directory exists
    const dir = join(homedir(), '.meer');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const content = yaml.stringify(config);
    writeFileSync(path, content, 'utf-8');
  } catch (error) {
    console.error(chalk.red('Failed to save MCP config:'), error);
    throw error;
  }
}

/**
 * Check if MCP configuration exists
 */
export function mcpConfigExists(configPath?: string): boolean {
  const path = configPath || DEFAULT_MCP_CONFIG_PATH;
  return existsSync(path);
}

/**
 * Get enabled MCP servers
 */
export function getEnabledServers(config: MCPConfig): Record<string, MCPServerConfig> {
  const enabled: Record<string, MCPServerConfig> = {};

  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    if (serverConfig.enabled) {
      enabled[name] = serverConfig;
    }
  }

  return enabled;
}

/**
 * Enable/disable a specific MCP server
 */
export function toggleServer(
  serverName: string,
  enabled: boolean,
  configPath?: string
): void {
  const config = loadMCPConfig(configPath);

  if (!config.mcpServers[serverName]) {
    throw new Error(`Server "${serverName}" not found in config`);
  }

  config.mcpServers[serverName].enabled = enabled;
  saveMCPConfig(config, configPath);
}

/**
 * Add a new MCP server to configuration
 */
export function addServer(
  name: string,
  serverConfig: MCPServerConfig,
  configPath?: string
): void {
  const config = loadMCPConfig(configPath);

  if (config.mcpServers[name]) {
    throw new Error(`Server "${name}" already exists in config`);
  }

  config.mcpServers[name] = serverConfig;
  saveMCPConfig(config, configPath);
}

/**
 * Remove an MCP server from configuration
 */
export function removeServer(serverName: string, configPath?: string): void {
  const config = loadMCPConfig(configPath);

  if (!config.mcpServers[serverName]) {
    throw new Error(`Server "${serverName}" not found in config`);
  }

  delete config.mcpServers[serverName];
  saveMCPConfig(config, configPath);
}

/**
 * Resolve environment variables in server configuration
 */
export function resolveEnvVars(config: MCPServerConfig): MCPServerConfig {
  const resolved = { ...config };

  if (config.env) {
    resolved.env = {};
    for (const [key, value] of Object.entries(config.env)) {
      // Replace ${VAR_NAME} with environment variable
      const match = value.match(/^\$\{(.+)\}$/);
      if (match) {
        const envVar = match[1];
        resolved.env[key] = process.env[envVar] || value;
      } else {
        resolved.env[key] = value;
      }
    }
  }

  if (config.headers) {
    resolved.headers = {};
    for (const [key, value] of Object.entries(config.headers)) {
      const match = value.match(/^\$\{(.+)\}$/);
      if (match) {
        const envVar = match[1];
        resolved.headers[key] = process.env[envVar] || value;
      } else {
        resolved.headers[key] = value;
      }
    }
  }

  if (config.url) {
    const match = config.url.match(/^\$\{(.+)\}$/);
    resolved.url = match ? process.env[match[1]] || config.url : config.url;
  }

  return resolved;
}

/**
 * Get default MCP configuration template
 */
export function getDefaultConfig(): MCPConfig {
  return JSON.parse(JSON.stringify(DEFAULT_MCP_CONFIG));
}

/**
 * Check if uvx is installed on the system
 */
export function checkUvxInstalled(): boolean {
  try {
    execSync('uvx --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get uvx installation instructions based on OS
 */
export function getUvxInstallInstructions(): string {
  const os = platform();

  if (os === 'darwin') {
    return `# Install uv (provides uvx) using Homebrew:
${chalk.cyan('brew install uv')}

# Or using the official installer:
${chalk.cyan('curl -LsSf https://astral.sh/uv/install.sh | sh')}`;
  } else if (os === 'win32') {
    return `# Install uv (provides uvx) using PowerShell:
${chalk.cyan('powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"')}

# Or using winget:
${chalk.cyan('winget install --id=astral-sh.uv  -e')}`;
  } else {
    // Linux and others
    return `# Install uv (provides uvx) using the official installer:
${chalk.cyan('curl -LsSf https://astral.sh/uv/install.sh | sh')}

# Or using pip:
${chalk.cyan('pip install uv')}`;
  }
}

/**
 * Get list of servers that require uvx
 */
export function getUvxRequiredServers(config: MCPConfig): string[] {
  const uvxServers: string[] = [];

  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    if (serverConfig.command === 'uvx' && serverConfig.enabled) {
      uvxServers.push(name);
    }
  }

  return uvxServers;
}

/**
 * Display uvx installation warning and instructions
 */
export function displayUvxWarning(): void {
  console.log(chalk.yellow('\n⚠️  uvx is not installed\n'));
  console.log(chalk.gray('Some MCP servers require uvx to run (git, fetch, time).'));
  console.log(chalk.gray('uvx is part of the uv Python package manager.\n'));
  console.log(chalk.bold('Installation instructions:\n'));
  console.log(getUvxInstallInstructions());
  console.log(chalk.gray('\nAfter installation, restart your terminal and try again.\n'));
}
