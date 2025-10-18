/**
 * MCP Client Wrapper
 * Handles connection and communication with a single MCP server
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
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
import { CircuitBreaker } from './circuitBreaker.js';
import { retryWithBackoff, RetryPredicates } from '../utils/retry.js';
import {
  log,
  mcpReconnections,
  circuitBreakerState,
  circuitBreakerTrips,
  CircuitState
} from '../telemetry/index.js';

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
  private processExitHandler?: () => void;
  private processErrorHandler?: (error: Error) => void;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;
  private circuitBreaker: CircuitBreaker;

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
          roots: {
            listChanged: true,
          },
          sampling: {},
        },
      }
    );

    // Set up request handlers for server-initiated requests
    this.client.setRequestHandler(
      ListRootsRequestSchema,
      async () => {
        // Return empty roots list - the server will use its configured roots
        return {
          roots: [],
        };
      }
    );

    // Initialize circuit breaker for this server
    this.circuitBreaker = new CircuitBreaker({
      name: `MCP:${serverName}`,
      failureThreshold: 5,
      resetTimeout: 60000, // 1 minute
      failureWindow: 10000, // 10 seconds
    });
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
    const startupTimeout = this.config.timeout || 30000;

    // Create connection promise with timeout
    const connectionPromise = new Promise<void>(async (resolve, reject) => {
      try {
        // Spawn the server process for logging / lifecycle management
        this.process = spawn(command, args, {
          env: {
            ...process.env,
            ...this.config.env,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        // Setup process error handler
        this.processErrorHandler = (error: Error) => {
          console.error(
            chalk.red(`  ❌ Failed to start ${this.serverName}:`),
            error.message
          );
          this.connected = false;
          reject(error);
        };
        this.process.on('error', this.processErrorHandler);

        // Setup process exit handler with reconnection logic
        this.processExitHandler = () => {
          const exitCode = this.process?.exitCode;
          const signal = this.process?.signalCode;

          console.error(
            chalk.red(
              `  ❌ MCP server ${this.serverName} exited unexpectedly: code=${exitCode}, signal=${signal}`
            )
          );

          this.connected = false;

          // Attempt reconnection if not manually disconnected and within retry limit
          if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 10000);

            console.log(
              chalk.yellow(
                `  🔄 Attempting to reconnect to ${this.serverName} (${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${delay}ms...`
              )
            );

            setTimeout(() => {
              this.reconnect().catch((error) => {
                console.error(
                  chalk.red(`  ❌ Reconnection failed for ${this.serverName}:`),
                  error instanceof Error ? error.message : String(error)
                );
              });
            }, delay);
          } else {
            console.error(
              chalk.red(
                `  ❌ Max reconnection attempts (${this.maxReconnectAttempts}) reached for ${this.serverName}. Giving up.`
              )
            );
          }
        };

        this.process.on('exit', this.processExitHandler);

        // Setup stderr logging
        this.process.stderr?.on('data', (data) => {
          const message = data.toString();
          if (message.trim()) {
            // Filter out debug messages unless in verbose mode
            if (!message.toLowerCase().includes('debug') || process.env.MCP_VERBOSE) {
              console.error(chalk.yellow(`  ⚠️  ${this.serverName}:`), message.trim());
            }
          }
        });

        // Optional: Setup stdout logging (some servers output to stdout)
        this.process.stdout?.on('data', (data) => {
          if (process.env.MCP_VERBOSE) {
            const message = data.toString();
            console.log(chalk.gray(`  📤 ${this.serverName}:`), message.trim());
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
        this.reconnectAttempts = 0; // Reset on successful connection
        resolve();
      } catch (error) {
        reject(error);
      }
    });

    // Race connection against timeout
    await Promise.race([
      connectionPromise,
      new Promise<void>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `MCP server ${this.serverName} startup timeout after ${startupTimeout}ms`
              )
            ),
          startupTimeout
        )
      ),
    ]);
  }

  /**
   * Attempt to reconnect after unexpected disconnection
   */
  private async reconnect(): Promise<void> {
    try {
      // Clean up existing process and transport
      if (this.process) {
        this.process.removeAllListeners();
        this.process.kill();
        this.process = undefined;
      }

      if (this.transport) {
        if (typeof (this.transport as any)?.close === 'function') {
          await (this.transport as any).close();
        }
        this.transport = undefined;
      }

      // Recreate client
      this.client = new Client(
        {
          name: `meer-cli-${this.serverName}`,
          version: '1.0.0',
        },
        {
          capabilities: {
            roots: {
              listChanged: true,
            },
            sampling: {},
          },
        }
      );

      // Re-setup request handlers
      this.client.setRequestHandler(
        ListRootsRequestSchema,
        async () => {
          return {
            roots: [],
          };
        }
      );

      // Attempt connection
      await this.connect();

      console.log(
        chalk.green(`  ✅ Successfully reconnected to ${this.serverName}`)
      );

      // Track successful reconnection
      mcpReconnections.inc({ server_name: this.serverName, success: 'true' });
      log.mcp(this.serverName, 'reconnect', { success: true });
    } catch (error) {
      // Track failed reconnection
      mcpReconnections.inc({ server_name: this.serverName, success: 'false' });
      log.mcp(this.serverName, 'error', {
        event: 'reconnection_failed',
        error: error instanceof Error ? error.message : String(error)
      });

      throw new Error(
        `Reconnection failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
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
   * Execute a tool on this server with circuit breaker and retry logic
   */
  async executeTool(toolName: string, params: any): Promise<MCPToolResult> {
    if (!this.connected) {
      return {
        success: false,
        content: [],
        error: `Server ${this.serverName} is not connected`,
      };
    }

    const startTime = Date.now();

    try {
      // Wrap execution in circuit breaker
      const result = await this.circuitBreaker.execute(async () => {
        // Wrap in retry logic with exponential backoff
        return await retryWithBackoff(
          async () => {
            const toolResult = await this.client.callTool({
              name: toolName,
              arguments: params,
            });
            return toolResult;
          },
          {
            maxRetries: 2, // 3 total attempts (1 initial + 2 retries)
            baseDelay: 500,
            maxDelay: 5000,
            shouldRetry: RetryPredicates.any(
              RetryPredicates.networkErrors,
              RetryPredicates.timeoutErrors
            ),
            name: `${this.serverName}.${toolName}`,
          }
        );
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
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check if error is from circuit breaker
      if (errorMessage.includes('Circuit breaker is OPEN')) {
        console.log(
          chalk.red(
            `  ⚡ Circuit breaker OPEN for ${this.serverName}. ` +
            `Use 'meer /mcp status' to check server health.`
          )
        );
      }

      return {
        success: false,
        content: [],
        error: errorMessage,
        metadata: {
          serverName: this.serverName,
          toolName,
          executionTime: Date.now() - startTime,
        },
      };
    }
  }

  /**
   * Get circuit breaker status
   */
  getCircuitBreakerStatus(): string {
    return this.circuitBreaker.getStatus();
  }

  /**
   * Reset circuit breaker (for manual intervention)
   */
  resetCircuitBreaker(): void {
    this.circuitBreaker.reset();
    console.log(
      chalk.green(`  ✅ Circuit breaker reset for ${this.serverName}`)
    );
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
    if (this.connected || this.process) {
      try {
        // Prevent reconnection attempts during manual disconnection
        this.reconnectAttempts = this.maxReconnectAttempts;

        // Remove event listeners to prevent memory leaks
        if (this.process) {
          if (this.processExitHandler) {
            this.process.removeListener('exit', this.processExitHandler);
          }
          if (this.processErrorHandler) {
            this.process.removeListener('error', this.processErrorHandler);
          }
          this.process.removeAllListeners('data');
          this.process.stderr?.removeAllListeners();
          this.process.stdout?.removeAllListeners();

          // Kill process gracefully with SIGTERM, then SIGKILL if needed
          if (this.process.pid && !this.process.killed) {
            this.process.kill('SIGTERM');

            // Give process 2 seconds to shut down gracefully
            await new Promise<void>((resolve) => {
              const timeout = setTimeout(() => {
                if (this.process && this.process.pid && !this.process.killed) {
                  console.log(
                    chalk.yellow(`  ⚠️  Force killing ${this.serverName} with SIGKILL`)
                  );
                  this.process.kill('SIGKILL');
                }
                resolve();
              }, 2000);

              this.process?.once('exit', () => {
                clearTimeout(timeout);
                resolve();
              });
            });
          }
        }

        // Close client and transport
        if (this.client) {
          await this.client.close();
        }

        if (this.transport) {
          if (typeof (this.transport as any)?.close === 'function') {
            await (this.transport as any).close();
          }
        }

        this.connected = false;
        this.process = undefined;
        this.transport = undefined;
        this.processExitHandler = undefined;
        this.processErrorHandler = undefined;

        console.log(chalk.gray(`  🔌 Disconnected from ${this.serverName}`));
      } catch (error) {
        console.error(
          chalk.red(`  ❌ Error disconnecting from ${this.serverName}:`),
          error instanceof Error ? error.message : String(error)
        );
      }
    }
  }
}
