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
        console.error(
          chalk.red(`  ❌ Failed to connect to ${serverNames[index]}:`),
          result.reason
        );
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

    const client = new MCPClient(serverName, serverConfig);
    await client.connect();
    this.clients.set(serverName, client);
  }

  /**
   * Disconnect from a specific server
   */
  async disconnectServer(serverName: string): Promise<void> {
    const client = this.clients.get(serverName);
    if (client) {
      await client.disconnect();
      this.clients.delete(serverName);
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

    const client = this.clients.get(serverName);
    if (!client) {
      return {
        success: false,
        content: [],
        error: `Server "${serverName}" is not connected`,
      };
    }

    if (!client.isConnected()) {
      return {
        success: false,
        content: [],
        error: `Server "${serverName}" is not connected`,
      };
    }

    return await client.executeTool(actualToolName, params);
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
