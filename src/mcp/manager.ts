/**
 * MCP Manager
 * Central manager for all MCP server connections and operations
 */

import chalk from 'chalk';
import type {
  MCPConfig,
  MCPTool,
  MCPResource,
  MCPPrompt,
  MCPToolResult,
  MCPClientInfo,
} from './types.js';
import { loadMCPConfig, getEnabledServers } from './config.js';
import { MCPClient } from './client.js';
import { logVerbose } from '../logger.js';
import {
  withMCPConnectionTelemetry,
  log,
  mcpConnectionsTotal,
  mcpActiveConnections
} from '../telemetry/index.js';

export class MCPManager {
  private static instance: MCPManager;
  private clients: Map<string, MCPClient> = new Map();
  private config: MCPConfig;
  private initialized = false;

  private constructor() {
    this.config = loadMCPConfig();
  }

  /**
   * Get singleton instance
   */
  static getInstance(): MCPManager {
    if (!MCPManager.instance) {
      MCPManager.instance = new MCPManager();
    }
    return MCPManager.instance;
  }

  /**
   * Initialize and connect to all enabled MCP servers
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      logVerbose(chalk.gray('MCP Manager already initialized'));
      return;
    }

    const enabledServers = getEnabledServers(this.config);
    const serverNames = Object.keys(enabledServers);

    if (serverNames.length === 0) {
      logVerbose(chalk.gray('No MCP servers enabled'));
      this.initialized = true;
      return;
    }

    console.log(
      chalk.blue(`\n🔌 Connecting to ${serverNames.length} MCP server(s)...`)
    );

    const results = await Promise.allSettled(
      serverNames.map((name) => this.connectServer(name))
    );

    let successCount = 0;
    let failCount = 0;

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        successCount++;
      } else {
        failCount++;
        const serverName = serverNames[index];
        console.error(
          chalk.red(`  ❌ Failed to connect to ${serverName}:`),
          result.reason
        );

        // Track connection failure in metrics
        mcpConnectionsTotal.inc({ server_name: serverName, status: 'failure' });
        log.mcp(serverName, 'error', { error: result.reason });
      }
    });

    if (successCount > 0) {
      console.log(
        chalk.green(
          `✓ Connected to ${successCount}/${serverNames.length} MCP server(s)`
        )
      );
    }

    if (failCount > 0) {
      console.log(
        chalk.yellow(
          `⚠️  ${failCount} server(s) failed to connect. Check configuration.`
        )
      );
    }

    this.initialized = true;
  }

  /**
   * Connect to a specific MCP server
   */
  async connectServer(serverName: string): Promise<void> {
    if (this.clients.has(serverName)) {
      logVerbose(chalk.gray(`Server ${serverName} already connected`));
      return;
    }

    const serverConfig = this.config.mcpServers[serverName];
    if (!serverConfig) {
      throw new Error(`Server ${serverName} not found in configuration`);
    }

    if (!serverConfig.enabled) {
      throw new Error(`Server ${serverName} is not enabled`);
    }

    await withMCPConnectionTelemetry(serverName, async () => {
      const client = new MCPClient(serverName, serverConfig);
      await client.connect();
      this.clients.set(serverName, client);

      // Update metrics
      mcpConnectionsTotal.inc({ server_name: serverName, status: 'success' });
      mcpActiveConnections.inc({ server_name: serverName });
    });
  }

  /**
   * Disconnect from a specific server
   */
  async disconnectServer(serverName: string): Promise<void> {
    const client = this.clients.get(serverName);
    if (client) {
      await client.disconnect();
      this.clients.delete(serverName);

      // Update metrics
      mcpActiveConnections.dec({ server_name: serverName });
      log.mcp(serverName, 'disconnect');
    }
  }

  /**
   * Disconnect from all servers
   */
  async disconnectAll(): Promise<void> {
    const disconnectPromises = Array.from(this.clients.values()).map((client) =>
      client.disconnect()
    );
    await Promise.allSettled(disconnectPromises);
    this.clients.clear();
    this.initialized = false;
  }

  /**
   * List all available tools from all connected servers
   */
  listAllTools(): MCPTool[] {
    const allTools: MCPTool[] = [];

    for (const client of this.clients.values()) {
      allTools.push(...client.getTools());
    }

    return allTools;
  }

  /**
   * List all available resources from all connected servers
   */
  listAllResources(): MCPResource[] {
    const allResources: MCPResource[] = [];

    for (const client of this.clients.values()) {
      allResources.push(...client.getResources());
    }

    return allResources;
  }

  /**
   * List all available prompts from all connected servers
   */
  listAllPrompts(): MCPPrompt[] {
    const allPrompts: MCPPrompt[] = [];

    for (const client of this.clients.values()) {
      allPrompts.push(...client.getPrompts());
    }

    return allPrompts;
  }

  /**
   * Execute a tool on the appropriate server
   */
  async executeTool(toolName: string, params: any): Promise<MCPToolResult> {
    // Validate tool name format
    if (!toolName || typeof toolName !== 'string') {
      return {
        success: false,
        content: [],
        error: `Invalid tool name: expected non-empty string, got "${String(toolName)}"`,
      };
    }

    const toolNameRegex = /^[a-z0-9_-]+\.[a-z0-9_.-]+$/i;
    if (!toolNameRegex.test(toolName)) {
      return {
        success: false,
        content: [],
        error: `Invalid tool name format. Expected "serverName.toolName" (alphanumeric with dots, dashes, underscores), got "${toolName}"`,
      };
    }

    // Parse server name from tool name (format: "serverName.toolName")
    const parts = toolName.split('.');
    if (parts.length < 2) {
      return {
        success: false,
        content: [],
        error: `Invalid tool name format. Expected "serverName.toolName", got "${toolName}"`,
      };
    }

    const serverName = parts[0];
    const actualToolName = parts.slice(1).join('.');

    // Check if server exists
    const client = this.clients.get(serverName);
    if (!client) {
      const availableServers = Array.from(this.clients.keys()).sort();
      const suggestion = this.findClosestServerName(serverName, availableServers);

      return {
        success: false,
        content: [],
        error: [
          `MCP server "${serverName}" not found.`,
          availableServers.length > 0
            ? `Available servers: ${availableServers.join(', ')}`
            : 'No MCP servers are currently connected.',
          suggestion ? `Did you mean "${suggestion}"?` : '',
          `\nTip: Use \`meer /mcp list\` to see all available servers and tools.`
        ].filter(Boolean).join('\n')
      };
    }

    // Check if server is connected
    if (!client.isConnected()) {
      return {
        success: false,
        content: [],
        error: `Server "${serverName}" is not connected. Please check the server status and try again.`,
      };
    }

    // Validate tool exists on server
    const availableTools = client.getTools();
    const toolExists = availableTools.some(t => t.originalName === actualToolName);
    if (!toolExists) {
      const availableToolNames = availableTools.map(t => t.originalName).sort();
      const toolSuggestion = this.findClosestToolName(actualToolName, availableToolNames);

      return {
        success: false,
        content: [],
        error: [
          `Tool "${actualToolName}" not found on server "${serverName}".`,
          availableToolNames.length > 0
            ? `Available tools: ${availableToolNames.join(', ')}`
            : `Server "${serverName}" has no tools available.`,
          toolSuggestion ? `Did you mean "${serverName}.${toolSuggestion}"?` : ''
        ].filter(Boolean).join('\n')
      };
    }

    return await client.executeTool(actualToolName, params);
  }

  /**
   * Find closest server name using simple edit distance
   */
  private findClosestServerName(input: string, available: string[]): string | null {
    if (available.length === 0) return null;

    const distances = available.map(name => ({
      name,
      distance: this.levenshteinDistance(input.toLowerCase(), name.toLowerCase())
    }));

    const closest = distances.sort((a, b) => a.distance - b.distance)[0];
    // Only suggest if distance is <= 3 (reasonable typo)
    return closest.distance <= 3 ? closest.name : null;
  }

  /**
   * Find closest tool name using simple edit distance
   */
  private findClosestToolName(input: string, available: string[]): string | null {
    if (available.length === 0) return null;

    const distances = available.map(name => ({
      name,
      distance: this.levenshteinDistance(input.toLowerCase(), name.toLowerCase())
    }));

    const closest = distances.sort((a, b) => a.distance - b.distance)[0];
    // Only suggest if distance is <= 3 (reasonable typo)
    return closest.distance <= 3 ? closest.name : null;
  }

  /**
   * Calculate Levenshtein distance between two strings
   */
  private levenshteinDistance(str1: string, str2: string): number {
    const len1 = str1.length;
    const len2 = str2.length;
    const matrix: number[][] = [];

    for (let i = 0; i <= len1; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= len2; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= len1; i++) {
      for (let j = 1; j <= len2; j++) {
        if (str1[i - 1] === str2[j - 1]) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            matrix[i][j - 1] + 1,     // insertion
            matrix[i - 1][j] + 1      // deletion
          );
        }
      }
    }

    return matrix[len1][len2];
  }

  /**
   * Read a resource from a server
   */
  async readResource(uri: string): Promise<string> {
    // Determine which server owns this resource
    for (const client of this.clients.values()) {
      const resources = client.getResources();
      if (resources.some((r) => r.uri === uri)) {
        return await client.readResource(uri);
      }
    }

    throw new Error(`No server found for resource: ${uri}`);
  }

  /**
   * Get info about all connected servers
   */
  getConnectedServers(): MCPClientInfo[] {
    return Array.from(this.clients.values()).map((client) => client.getInfo());
  }

  /**
   * Check if a specific server is connected
   */
  isServerConnected(serverName: string): boolean {
    const client = this.clients.get(serverName);
    return client?.isConnected() ?? false;
  }

  /**
   * Get total count of connected servers
   */
  getConnectedCount(): number {
    return Array.from(this.clients.values()).filter((c) => c.isConnected())
      .length;
  }

  /**
   * Check if MCP manager is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Reload configuration and reconnect
   */
  async reload(): Promise<void> {
    await this.disconnectAll();
    this.config = loadMCPConfig();
    await this.initialize();
  }

  /**
   * Get configuration
   */
  getConfig(): MCPConfig {
    return this.config;
  }
}
