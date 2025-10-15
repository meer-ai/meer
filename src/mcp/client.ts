/**
 * MCP Client Wrapper
 * Handles connection and communication with a single MCP server
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawn, type ChildProcess } from 'child_process';
import chalk from 'chalk';
import type {
  MCPServerConfig,
  MCPTool,
  MCPResource,
  MCPPrompt,
  MCPToolResult,
  MCPClientInfo,
} from './types.js';
import { resolveEnvVars } from './config.js';

export class MCPClient {
  private client: Client;
  private transport?: any;
  private process?: ChildProcess;
  private connected = false;
  private serverName: string;
  private config: MCPServerConfig;
  private tools: MCPTool[] = [];
  private resources: MCPResource[] = [];
  private prompts: MCPPrompt[] = [];

  constructor(serverName: string, config: MCPServerConfig) {
    this.serverName = serverName;
    this.config = resolveEnvVars(config);
    this.client = new Client(
      {
        name: `meer-cli-${serverName}`,
        version: '1.0.0',
      },
      {
        capabilities: {
          roots: {},
          sampling: {},
        },
      }
    );
  }

  /**
   * Connect to the MCP server
   */
  async connect(): Promise<void> {
    try {
      console.log(chalk.gray(`  🔌 Connecting to MCP server: ${this.serverName}...`));

      if (this.config.url) {
        await this.connectViaUrl();
      } else {
        await this.connectViaProcess();
      }

      this.connected = true;

      // Load capabilities
      await this.loadCapabilities();

      console.log(
        chalk.green(
          `  ✓ Connected to ${this.serverName} (${this.tools.length} tools, ${this.resources.length} resources)`
        )
      );
    } catch (error) {
      this.connected = false;
      throw new Error(
        `Failed to connect to ${this.serverName}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private async connectViaProcess(): Promise<void> {
    const command = this.config.command;
    if (!command) {
      throw new Error(
        `Server ${this.serverName} is missing a command configuration`
      );
    }

    const args = this.config.args ?? [];

    // Spawn the server process for logging / lifecycle management
    this.process = spawn(command, args, {
      env: {
        ...process.env,
        ...this.config.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.on('error', (error) => {
      console.error(
        chalk.red(`  ❌ Failed to start ${this.serverName}:`),
        error.message
      );
    });

    this.process.stderr?.on('data', (data) => {
      const message = data.toString();
      if (message.trim()) {
        console.error(chalk.yellow(`  ⚠️  ${this.serverName}:`), message);
      }
    });

    const transportEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        transportEnv[key] = value;
      }
    }
    if (this.config.env) {
      Object.assign(transportEnv, this.config.env);
    }

    this.transport = new StdioClientTransport({
      command,
      args,
      env: transportEnv,
    });

    await this.client.connect(this.transport);
  }

  private async connectViaUrl(): Promise<void> {
    const url = this.config.url!;
    const urlInstance = new URL(url);
    const transportType =
      this.config.transport ??
      (url.toLowerCase().startsWith('ws') ? 'websocket' : 'streaming-http');

    if (transportType === 'websocket') {
      this.transport = new WebSocketClientTransport(urlInstance);
    } else {
      const headers = this.config.headers ?? {};
      this.transport = new StreamableHTTPClientTransport(urlInstance, {
        requestInit: {
          headers,
        },
      });
    }

    await this.client.connect(this.transport);
  }

  /**
   * Load tools, resources, and prompts from the server
   */
  private async loadCapabilities(): Promise<void> {
    try {
      // List tools
      const toolsResponse = await this.client.listTools();
      this.tools = toolsResponse.tools.map((tool) => ({
        name: `${this.serverName}.${tool.name}`,
        originalName: tool.name,
        serverName: this.serverName,
        description: tool.description || '',
        inputSchema: tool.inputSchema as any,
      }));

      // List resources
      try {
        const resourcesResponse = await this.client.listResources();
        this.resources = resourcesResponse.resources.map((resource) => ({
          uri: resource.uri,
          serverName: this.serverName,
          name: resource.name,
          description: resource.description,
          mimeType: resource.mimeType,
        }));
      } catch (error) {
        // Resources might not be supported
        this.resources = [];
      }

      // List prompts
      try {
        const promptsResponse = await this.client.listPrompts();
        this.prompts = promptsResponse.prompts.map((prompt) => ({
          name: prompt.name,
          serverName: this.serverName,
          description: prompt.description,
          arguments: prompt.arguments as any,
        }));
      } catch (error) {
        // Prompts might not be supported
        this.prompts = [];
      }
    } catch (error) {
      console.error(
        chalk.yellow(`  ⚠️  Failed to load capabilities for ${this.serverName}`)
      );
    }
  }

  /**
   * Execute a tool on this server
   */
  async executeTool(toolName: string, params: any): Promise<MCPToolResult> {
    if (!this.connected) {
      throw new Error(`Server ${this.serverName} is not connected`);
    }

    const startTime = Date.now();

    try {
      const result = await this.client.callTool({
        name: toolName,
        arguments: params,
      });

      return {
        success: true,
        content: result.content as any,
        metadata: {
          serverName: this.serverName,
          toolName,
          executionTime: Date.now() - startTime,
        },
      };
    } catch (error) {
      return {
        success: false,
        content: [],
        error: error instanceof Error ? error.message : String(error),
        metadata: {
          serverName: this.serverName,
          toolName,
          executionTime: Date.now() - startTime,
        },
      };
    }
  }

  /**
   * Read a resource from this server
   */
  async readResource(uri: string): Promise<string> {
    if (!this.connected) {
      throw new Error(`Server ${this.serverName} is not connected`);
    }

    try {
      const result = await this.client.readResource({ uri });

      // Combine all text content
      return result.contents
        .map((content) => {
          if ('text' in content) {
            return content.text;
          }
          return '';
        })
        .join('\n');
    } catch (error) {
      throw new Error(
        `Failed to read resource ${uri}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Get available tools
   */
  getTools(): MCPTool[] {
    return this.tools;
  }

  /**
   * Get available resources
   */
  getResources(): MCPResource[] {
    return this.resources;
  }

  /**
   * Get available prompts
   */
  getPrompts(): MCPPrompt[] {
    return this.prompts;
  }

  /**
   * Get client info
   */
  getInfo(): MCPClientInfo {
    return {
      name: this.serverName,
      client: this.client,
      status: this.connected ? 'connected' : 'disconnected',
      tools: this.tools,
      resources: this.resources,
      prompts: this.prompts,
    };
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Disconnect from the server
   */
  async disconnect(): Promise<void> {
    if (this.connected) {
      try {
        await this.client.close();
        if (typeof (this.transport as any)?.close === 'function') {
          await (this.transport as any).close();
        }
        this.process?.kill();
        this.connected = false;
        console.log(chalk.gray(`  🔌 Disconnected from ${this.serverName}`));
      } catch (error) {
        console.error(
          chalk.red(`  ❌ Error disconnecting from ${this.serverName}:`),
          error
        );
      }
    }
  }
}
