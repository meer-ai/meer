/**
 * File-backed OAuth client provider for remote MCP servers.
 *
 * Implements the MCP SDK `OAuthClientProvider` interface, persisting the
 * dynamically-registered client, PKCE verifier, and tokens to
 * `~/.meer/mcp-auth/<server>.json` (0600). The SDK drives the flow: it reads
 * tokens for connections, refreshes them when expired, and calls
 * `redirectToAuthorization` when interactive consent is required.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

const MCP_AUTH_DIR = join(homedir(), '.meer', 'mcp-auth');

/** Thrown when a server needs interactive login but none is available. */
export class MCPAuthRequiredError extends Error {
  constructor(public readonly serverName: string) {
    super(
      `MCP server "${serverName}" requires authentication. Run \`meer mcp login ${serverName}\` to sign in.`
    );
    this.name = 'MCPAuthRequiredError';
  }
}

interface StoredAuth {
  clientInformation?: OAuthClientInformationFull;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
}

/** Map a server name to a safe credential filename. */
function authFilePath(serverName: string): string {
  const safe = serverName.replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(MCP_AUTH_DIR, `${safe}.json`);
}

function readStore(serverName: string): StoredAuth {
  const path = authFilePath(serverName);
  if (!existsSync(path)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as StoredAuth;
  } catch {
    return {};
  }
}

function writeStore(serverName: string, data: StoredAuth): void {
  if (!existsSync(MCP_AUTH_DIR)) {
    mkdirSync(MCP_AUTH_DIR, { recursive: true });
  }
  const path = authFilePath(serverName);
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort on platforms without POSIX permissions (e.g. Windows).
  }
}

export interface MCPOAuthProviderOptions {
  /** Loopback URL the authorization server redirects back to. */
  redirectUrl: string;
  /** OAuth scopes to request, space-separated. */
  scope?: string;
  /**
   * Called when interactive authorization is required. When omitted (the
   * non-interactive connection path), an {@link MCPAuthRequiredError} is thrown
   * instead so the caller can tell the user to run `meer mcp login`.
   */
  onRedirect?: (authorizationUrl: URL) => void | Promise<void>;
}

/**
 * Persistent OAuth provider for a single MCP server. One instance per server.
 */
export class MCPOAuthProvider implements OAuthClientProvider {
  constructor(
    private readonly serverName: string,
    private readonly options: MCPOAuthProviderOptions
  ) {}

  get redirectUrl(): string {
    return this.options.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Meer CLI',
      redirect_uris: [this.options.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(this.options.scope ? { scope: this.options.scope } : {}),
    };
  }

  state(): string {
    const store = readStore(this.serverName);
    if (store.state) {
      return store.state;
    }
    const state = randomBytes(16).toString('hex');
    writeStore(this.serverName, { ...store, state });
    return state;
  }

  clientInformation(): OAuthClientInformation | undefined {
    return readStore(this.serverName).clientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformationFull): void {
    const store = readStore(this.serverName);
    writeStore(this.serverName, { ...store, clientInformation });
  }

  tokens(): OAuthTokens | undefined {
    return readStore(this.serverName).tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    const store = readStore(this.serverName);
    writeStore(this.serverName, { ...store, tokens });
  }

  saveCodeVerifier(codeVerifier: string): void {
    const store = readStore(this.serverName);
    writeStore(this.serverName, { ...store, codeVerifier });
  }

  codeVerifier(): string {
    const verifier = readStore(this.serverName).codeVerifier;
    if (!verifier) {
      throw new Error(`No PKCE code verifier saved for "${this.serverName}"`);
    }
    return verifier;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.options.onRedirect) {
      throw new MCPAuthRequiredError(this.serverName);
    }
    await this.options.onRedirect(authorizationUrl);
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier'): void {
    if (scope === 'all') {
      clearMCPAuth(this.serverName);
      return;
    }
    const store = readStore(this.serverName);
    if (scope === 'client') delete store.clientInformation;
    if (scope === 'tokens') delete store.tokens;
    if (scope === 'verifier') delete store.codeVerifier;
    writeStore(this.serverName, store);
  }
}

/** Whether stored OAuth tokens exist for a server. */
export function hasMCPAuth(serverName: string): boolean {
  return Boolean(readStore(serverName).tokens);
}

/** Remove all stored OAuth credentials for a server. Returns true if removed. */
export function clearMCPAuth(serverName: string): boolean {
  const path = authFilePath(serverName);
  if (!existsSync(path)) {
    return false;
  }
  rmSync(path, { force: true });
  return true;
}
