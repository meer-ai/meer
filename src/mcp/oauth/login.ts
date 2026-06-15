/**
 * Interactive OAuth login flow for remote MCP servers.
 *
 * Starts a loopback HTTP server to capture the authorization redirect, opens
 * the user's browser to the consent screen, exchanges the returned code for
 * tokens via the SDK transport's `finishAuth`, and verifies the connection.
 * Tokens are persisted by {@link MCPOAuthProvider}.
 */

import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { MCPOAuthProvider } from './provider.js';
import type { MCPServerConfig } from '../types.js';

export interface MCPLoginResult {
  toolCount: number;
}

interface CallbackResult {
  code: string;
  state?: string;
}

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes to complete consent

/**
 * Run the full OAuth authorization-code (PKCE) flow for a remote MCP server.
 *
 * @param serverName Logical server name (used for credential storage).
 * @param config Server config; must define a remote `url`.
 * @param onUrl Invoked with the consent URL (open browser / print fallback).
 */
export async function loginToMCPServer(
  serverName: string,
  config: MCPServerConfig,
  onUrl: (url: URL) => void | Promise<void>
): Promise<MCPLoginResult> {
  if (!config.url) {
    throw new Error(
      `Server "${serverName}" is a stdio (command) server. OAuth login only applies to remote (url) servers.`
    );
  }

  const serverUrl = new URL(config.url);

  // 1. Start the loopback callback server on an ephemeral port.
  let resolveCallback: (result: CallbackResult) => void;
  let rejectCallback: (error: Error) => void;
  const callbackPromise = new Promise<CallbackResult>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const httpServer: Server = createServer((req, res) => {
    if (!req.url) return;
    const reqUrl = new URL(req.url, 'http://localhost');
    if (reqUrl.pathname !== '/callback') {
      res.writeHead(404).end('Not found');
      return;
    }

    const error = reqUrl.searchParams.get('error');
    const code = reqUrl.searchParams.get('code');
    const state = reqUrl.searchParams.get('state') ?? undefined;

    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (error) {
      const description = reqUrl.searchParams.get('error_description') ?? '';
      res.end(renderCallbackPage(false, `${error}${description ? `: ${description}` : ''}`));
      rejectCallback(new Error(`Authorization failed: ${error}${description ? ` — ${description}` : ''}`));
      return;
    }
    if (!code) {
      res.end(renderCallbackPage(false, 'No authorization code was returned.'));
      rejectCallback(new Error('No authorization code returned in callback'));
      return;
    }
    res.end(renderCallbackPage(true));
    resolveCallback({ code, state });
  });

  const port = await new Promise<number>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      resolve((httpServer.address() as AddressInfo).port);
    });
  });

  const redirectUrl = `http://localhost:${port}/callback`;

  try {
    const provider = new MCPOAuthProvider(serverName, {
      redirectUrl,
      scope: config.oauthScope,
      onRedirect: async (authUrl) => {
        await onUrl(authUrl);
      },
    });

    // 2. Trigger discovery + dynamic registration + redirect by attempting a
    //    connection. The provider's onRedirect fires; connect then throws
    //    UnauthorizedError, which is expected — we resume after the callback.
    const transport = new StreamableHTTPClientTransport(serverUrl, {
      authProvider: provider,
      requestInit: { headers: config.headers ?? {} },
    });
    const client = new Client({ name: `meer-cli-${serverName}`, version: '1.0.0' }, { capabilities: {} });

    try {
      await client.connect(transport);
      // Already had valid tokens — nothing more to do.
      const tools = await safeToolCount(client);
      await client.close();
      return { toolCount: tools };
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) {
        throw err;
      }
    }

    // 3. Wait for the user to finish consent in the browser.
    const callback = await withTimeout(
      callbackPromise,
      CALLBACK_TIMEOUT_MS,
      'Timed out waiting for authorization (5 minutes). Please run the command again.'
    );

    const expectedState = await provider.state();
    if (callback.state && expectedState && callback.state !== expectedState) {
      throw new Error('OAuth state mismatch — possible CSRF. Aborting login.');
    }

    // 4. Exchange the code for tokens (persisted by the provider).
    await transport.finishAuth(callback.code);

    // 5. Verify by establishing an authenticated connection.
    const verifyTransport = new StreamableHTTPClientTransport(serverUrl, {
      authProvider: provider,
      requestInit: { headers: config.headers ?? {} },
    });
    const verifyClient = new Client(
      { name: `meer-cli-${serverName}`, version: '1.0.0' },
      { capabilities: {} }
    );
    await verifyClient.connect(verifyTransport);
    const toolCount = await safeToolCount(verifyClient);
    await verifyClient.close();

    return { toolCount };
  } finally {
    httpServer.close();
  }
}

async function safeToolCount(client: Client): Promise<number> {
  try {
    const res = await client.listTools();
    return res.tools.length;
  } catch {
    return 0;
  }
}

/**
 * Turn noisy SDK/OAuth errors into a single readable line. The MCP SDK wraps
 * non-standard authorization-server responses with a Zod dump but appends the
 * server's actual JSON as `Raw body: {...}` — surface that message instead.
 */
export function humanizeMCPOAuthError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const marker = raw.indexOf('Raw body:');
  if (marker === -1) {
    return raw;
  }
  const bodyText = raw.slice(marker + 'Raw body:'.length).trim();
  try {
    const body = JSON.parse(bodyText);
    const message =
      body.error_description || body.message || body.error || bodyText;
    return typeof message === 'string' ? message : bodyText;
  } catch {
    return bodyText || raw;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

function renderCallbackPage(success: boolean, message?: string): string {
  const title = success ? '✓ Authorization complete' : '✗ Authorization failed';
  const body = success
    ? 'You can close this tab and return to your terminal.'
    : message ?? 'Something went wrong.';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Meer MCP</title>
<style>body{font-family:system-ui,sans-serif;background:#0b1020;color:#e6e9f0;display:flex;
align-items:center;justify-content:center;height:100vh;margin:0}
.card{text-align:center;padding:2rem 3rem;border-radius:12px;background:#141a2e}
h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#9aa3b8;margin:0}</style></head>
<body><div class="card"><h1>${title}</h1><p>${body}</p></div></body></html>`;
}
