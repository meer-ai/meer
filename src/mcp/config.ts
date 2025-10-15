/**
 * MCP Configuration Management
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
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
 */
const DEFAULT_MCP_CONFIG: MCPConfig = {
  mcpServers: {
    filesystem: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', DEFAULT_FILESYSTEM_ROOT],
      enabled: false,
      description: 'Secure file operations with configurable access controls',
      timeout: 30000,
    },
    memory: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
      enabled: false,
      description: 'Knowledge graph-based persistent memory system',
      timeout: 30000,
    },
    fetch: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-fetch'],
      enabled: false,
      description: 'Web content fetching and conversion to markdown',
      timeout: 30000,
    },
    brave: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-brave-search'],
      env: {
        BRAVE_API_KEY: '${BRAVE_API_KEY}',
      },
      enabled: false,
      description: 'Web search using Brave Search API',
      timeout: 30000,
    },
    puppeteer: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-puppeteer'],
      enabled: false,
      description: 'Browser automation and web scraping',
      timeout: 30000,
    },
    github: {
      command: 'docker',
      args: [
        'run',
        '-i',
        '--rm',
        'ghcr.io/github/github-mcp-server'
      ],
      env: {
        GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN}',
      },
      enabled: false,
      description: 'GitHub API integration (repos, issues, PRs, search)',
      timeout: 30000,
    },
    'figma-desktop': {
      url: 'http://127.0.0.1:3845/mcp',
      transport: 'streaming-http',
      enabled: false,
      description: 'Access designs from a running Figma Desktop instance',
      timeout: 30000,
    },
  },
  mcp: {
    autoStart: false,
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
