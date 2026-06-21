/**
 * Lock down the MCP OAuth credential provider used by `meer mcp login`.
 *
 * Invariants:
 *   - Credentials round-trip through ~/.meer/mcp-auth/<server>.json
 *   - Stored credential files are created with 0600 permissions
 *   - clientMetadata is a valid public-client (PKCE) registration request
 *   - redirectToAuthorization throws MCPAuthRequiredError on the non-interactive
 *     path (no onRedirect), so connections fail loud instead of hanging
 *   - invalidateCredentials honors its scope; clearMCPAuth wipes everything
 *
 * HOME is redirected to a temp dir BEFORE importing the provider, since the
 * auth directory path is resolved at module load.
 */

import { mkdtempSync, existsSync, statSync, rmSync } from 'fs';
import { tmpdir, platform } from 'os';
import { join } from 'path';

const tempHome = mkdtempSync(join(tmpdir(), 'meer-mcp-oauth-'));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

const { MCPOAuthProvider, MCPAuthRequiredError, hasMCPAuth, clearMCPAuth } = await import(
  '@meer-ai/coding-agent/mcp/oauth/provider.js'
);

const SERVER = 'notion';
const authFile = join(tempHome, '.meer', 'mcp-auth', `${SERVER}.json`);

// --- clean slate -----------------------------------------------------------
assert(hasMCPAuth(SERVER) === false, 'no auth before saving anything');
assert(clearMCPAuth(SERVER) === false, 'clearing nonexistent creds returns false');

const provider = new MCPOAuthProvider(SERVER, {
  redirectUrl: 'http://localhost:9999/callback',
  scope: 'read write',
});

// --- clientMetadata is a valid public-client registration ------------------
const meta = provider.clientMetadata;
assert(meta.client_name === 'Meer CLI', 'client_name set');
assert(
  Array.isArray(meta.redirect_uris) && meta.redirect_uris[0] === 'http://localhost:9999/callback',
  'redirect_uris carries the loopback URL'
);
assert(meta.token_endpoint_auth_method === 'none', 'public client (PKCE, no secret)');
assert((meta.grant_types ?? []).includes('refresh_token'), 'refresh_token grant requested');
assert(meta.scope === 'read write', 'scope forwarded');

// --- PKCE verifier round-trip ----------------------------------------------
provider.saveCodeVerifier('verifier-123');
assert(provider.codeVerifier() === 'verifier-123', 'code verifier round-trips');

// --- client information round-trip ------------------------------------------
provider.saveClientInformation({ client_id: 'abc', redirect_uris: [meta.redirect_uris[0]] } as any);
assert(provider.clientInformation()?.client_id === 'abc', 'client information round-trips');

// --- tokens round-trip + hasMCPAuth ----------------------------------------
assert(hasMCPAuth(SERVER) === false, 'no auth until tokens saved');
provider.saveTokens({ access_token: 'tok', token_type: 'bearer', refresh_token: 'r' } as any);
assert(provider.tokens()?.access_token === 'tok', 'tokens round-trip');
assert(hasMCPAuth(SERVER) === true, 'hasMCPAuth true once tokens stored');

// --- file permissions are 0600 (POSIX only) --------------------------------
assert(existsSync(authFile), 'credential file written');
if (platform() !== 'win32') {
  const mode = statSync(authFile).mode & 0o777;
  assert(mode === 0o600, `credential file is 0600 (got ${mode.toString(8)})`);
}

// --- non-interactive redirect must throw, not hang -------------------------
let threw = false;
try {
  await provider.redirectToAuthorization(new URL('https://auth.example.com/authorize'));
} catch (err) {
  threw = err instanceof MCPAuthRequiredError;
}
assert(threw, 'redirectToAuthorization throws MCPAuthRequiredError without onRedirect');

// --- scoped invalidation ----------------------------------------------------
provider.invalidateCredentials('tokens');
assert(provider.tokens() === undefined, 'tokens invalidated');
assert(provider.clientInformation()?.client_id === 'abc', 'client info survives token invalidation');
assert(hasMCPAuth(SERVER) === false, 'hasMCPAuth false after token invalidation');

// --- full clear -------------------------------------------------------------
assert(clearMCPAuth(SERVER) === true, 'clearMCPAuth removes file');
assert(existsSync(authFile) === false, 'credential file gone after clear');
assert(provider.clientInformation() === undefined, 'no client info after clear');

// --- filename sanitization for awkward server names ------------------------
const weird = new MCPOAuthProvider('weird/../name', {
  redirectUrl: 'http://localhost:1/callback',
});
weird.saveTokens({ access_token: 'x', token_type: 'bearer' } as any);
assert(hasMCPAuth('weird/../name') === true, 'sanitized name still round-trips');
clearMCPAuth('weird/../name');

rmSync(tempHome, { recursive: true, force: true });

console.log('✓ verify-mcp-oauth passed');
