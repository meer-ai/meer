/**
 * MCP (Model Context Protocol) Type Definitions
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

/**
 * Configuration for a single MCP server
 */
export interface MCPServerConfig {
  /** Command to execute (e.g., 'npx', 'node') */
  command: string;

  /** Arguments to pass to the command */
  args: string[];

  /** Environment variables */
  env?: Record<string, string>;

  /** Whether this server is enabled */
  enabled: boolean;

  /** Human-readable description */
  description?: string;

  /** Timeout in milliseconds */
  timeout?: number;
}

/**
 * Global MCP configuration
 */
export interface MCPConfig {
  /** Map of server name to configuration */
  mcpServers: Record<string, MCPServerConfig>;

  /** Global MCP settings */
  mcp?: {
    /** Auto-start servers on CLI launch */
    autoStart?: boolean;

    /** Default connection timeout (ms) */
    timeout?: number;

    /** Maximum connection retries */
    maxRetries?: number;

    /** Cache tool/resource lists */
    cacheTools?: boolean;

    /** Log level */
    logLevel?: 'debug' | 'info' | 'warn' | 'error';
  };
}

/**
 * MCP Tool definition
 */
export interface MCPTool {
  /** Tool name (prefixed with server name) */
  name: string;

  /** Original tool name from server */
  originalName: string;

  /** Server this tool comes from */
  serverName: string;

  /** Tool description */
  description: string;

  /** Input schema (JSON Schema) */
  inputSchema: {
    type: string;
    properties?: Record<string, any>;
    required?: string[];
  };
}

/**
 * MCP Resource definition
 */
export interface MCPResource {
  /** Resource URI */
  uri: string;

  /** Server this resource comes from */
  serverName: string;

  /** Resource name */
  name: string;

  /** Resource description */
  description?: string;

  /** MIME type */
  mimeType?: string;
}

/**
 * MCP Prompt definition
 */
export interface MCPPrompt {
  /** Prompt name */
  name: string;

  /** Server this prompt comes from */
  serverName: string;

  /** Prompt description */
  description?: string;

  /** Prompt arguments */
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

/**
 * Connected MCP client info
 */
export interface MCPClientInfo {
  /** Server name */
  name: string;

  /** MCP client instance */
  client: Client;

  /** Connection status */
  status: 'connected' | 'disconnected' | 'error';

  /** Available tools from this server */
  tools: MCPTool[];

  /** Available resources from this server */
  resources: MCPResource[];

  /** Available prompts from this server */
  prompts: MCPPrompt[];

  /** Last error message */
  error?: string;

  /** Connection timestamp */
  connectedAt?: Date;
}

/**
 * MCP Tool execution result
 */
export interface MCPToolResult {
  /** Whether execution succeeded */
  success: boolean;

  /** Result content */
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
  }>;

  /** Error message if failed */
  error?: string;

  /** Execution metadata */
  metadata?: {
    serverName: string;
    toolName: string;
    executionTime: number;
  };
}

/**
 * MCP server discovery result
 */
export interface MCPServerSuggestion {
  /** Server name/package */
  name: string;

  /** NPM package name */
  package: string;

  /** Description */
  description: string;

  /** Confidence score (0-1) */
  confidence: number;

  /** Reason for suggestion */
  reason: string;
}
