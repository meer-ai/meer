/**
 * ChatGPT OAuth2 + PKCE login flow.
 *
 * Uses OpenAI's public OAuth endpoints to authenticate users with their
 * ChatGPT Plus/Pro account (no API key required). Supports two methods:
 *   - Browser login: opens localhost:1455, waits for redirect
 *   - Device code: headless / remote environments
 */

import { createServer } from "http";
import { randomBytes } from "crypto";
import { generatePKCE } from "./pkce.js";
import { fetchWithTimeout, REQUEST_TIMEOUT_MS } from "../../utils/fetch.js";

// ── OAuth constants ────────────────────────────────────────────────────────

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_BASE = "https://auth.openai.com";
const AUTHORIZE_URL = `${AUTH_BASE}/oauth/authorize`;
const TOKEN_URL = `${AUTH_BASE}/oauth/token`;
const REDIRECT_URI = "http://localhost:1455/auth/callback";

const DEVICE_USER_CODE_URL = `${AUTH_BASE}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_BASE}/api/accounts/deviceauth/token`;
const DEVICE_REDIRECT_URI = `${AUTH_BASE}/deviceauth/callback`;
const DEVICE_VERIFICATION_URI = `${AUTH_BASE}/codex/device`;
const DEVICE_TIMEOUT_S = 15 * 60;

const SCOPE = "openid profile email offline_access";
const JWT_CLAIM = "https://api.openai.com/auth";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ChatGPTCredentials {
  access: string;
  refresh: string;
  expires: number;  // ms timestamp
  accountId: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function createState(): string {
  return randomBytes(16).toString("hex");
}

function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(atob(parts[1]!)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractAccountId(accessToken: string): string {
  const payload = decodeJwt(accessToken);
  const auth = payload?.[JWT_CLAIM] as { chatgpt_account_id?: string } | undefined;
  const id = auth?.chatgpt_account_id;
  if (!id) throw new Error("Could not extract chatgpt_account_id from access token");
  return id;
}

function parseAuthInput(input: string): { code?: string; state?: string } {
  const trimmed = input.trim();
  if (!trimmed) return {};
  try {
    const url = new URL(trimmed);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch { /* not a URL */ }
  if (trimmed.includes("code=")) {
    const params = new URLSearchParams(trimmed);
    return { code: params.get("code") ?? undefined, state: params.get("state") ?? undefined };
  }
  return { code: trimmed };
}

async function exchangeCode(
  code: string,
  verifier: string,
  redirectUri: string,
  signal?: AbortSignal
): Promise<ChatGPTCredentials> {
  const res = await fetchWithTimeout(
    TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }).toString(),
      signal,
    },
    REQUEST_TIMEOUT_MS
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Token exchange failed (${res.status}): ${body || res.statusText}`);
  }

  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error(`Unexpected token response: ${JSON.stringify(json)}`);
  }

  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    accountId: extractAccountId(json.access_token),
  };
}

// ── Token refresh ──────────────────────────────────────────────────────────

export async function refreshChatGPTToken(refreshToken: string): Promise<ChatGPTCredentials> {
  const res = await fetchWithTimeout(
    TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }).toString(),
    },
    REQUEST_TIMEOUT_MS
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Token refresh failed (${res.status}): ${body || res.statusText}`);
  }

  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error(`Unexpected refresh response: ${JSON.stringify(json)}`);
  }

  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    accountId: extractAccountId(json.access_token),
  };
}

// ── Browser login ──────────────────────────────────────────────────────────

function startCallbackServer(expectedState: string): Promise<{
  waitForCode: () => Promise<string | null>;
  close: () => void;
}> {
  return new Promise((resolve) => {
    let settle: ((code: string | null) => void) | undefined;
    const codePromise = new Promise<string | null>((res) => { settle = res; });

    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? "", "http://localhost");
        if (url.pathname !== "/auth/callback") {
          res.writeHead(404).end("Not found");
          return;
        }
        if (url.searchParams.get("state") !== expectedState) {
          res.writeHead(400, { "Content-Type": "text/html" })
            .end("<p>State mismatch — please retry login.</p>");
          return;
        }
        const code = url.searchParams.get("code");
        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html" })
            .end("<p>Missing authorization code.</p>");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html" })
          .end("<p>Authentication successful — you can close this tab.</p>");
        settle?.(code);
      } catch {
        res.writeHead(500).end("Internal error");
      }
    });

    server.listen(1455, "127.0.0.1", () => {
      resolve({
        waitForCode: () => codePromise,
        close: () => server.close(),
      });
    }).on("error", () => {
      settle?.(null);
      resolve({
        waitForCode: () => codePromise,
        close: () => {},
      });
    });
  });
}

export async function loginChatGPTBrowser(options: {
  onUrl: (url: string) => void;
  onManualPrompt: () => Promise<string>;
  signal?: AbortSignal;
}): Promise<ChatGPTCredentials> {
  const { verifier, challenge } = await generatePKCE();
  const state = createState();

  const authUrl = new URL(AUTHORIZE_URL);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("scope", SCOPE);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("id_token_add_organizations", "true");
  authUrl.searchParams.set("codex_cli_simplified_flow", "true");
  authUrl.searchParams.set("originator", "meer");

  const server = await startCallbackServer(state);
  options.onUrl(authUrl.toString());

  let code: string | undefined;

  try {
    const serverCode = await Promise.race([
      server.waitForCode(),
      // Give the browser 3 minutes to complete before falling back to manual
      new Promise<null>((res) => setTimeout(() => res(null), 3 * 60 * 1000)),
    ]);

    if (serverCode) {
      code = serverCode;
    } else {
      const input = await options.onManualPrompt();
      const parsed = parseAuthInput(input);
      if (parsed.state && parsed.state !== state) throw new Error("State mismatch");
      code = parsed.code;
    }
  } finally {
    server.close();
  }

  if (!code) throw new Error("No authorization code received");
  return exchangeCode(code, verifier, REDIRECT_URI, options.signal);
}

// ── Device code login ──────────────────────────────────────────────────────

export async function loginChatGPTDeviceCode(options: {
  onCode: (info: { userCode: string; verificationUri: string }) => void;
  signal?: AbortSignal;
}): Promise<ChatGPTCredentials> {
  const initRes = await fetchWithTimeout(
    DEVICE_USER_CODE_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID }),
      signal: options.signal,
    },
    REQUEST_TIMEOUT_MS
  );

  if (!initRes.ok) {
    const body = await initRes.text().catch(() => "");
    throw new Error(`Device code request failed (${initRes.status}): ${body}`);
  }

  const init = (await initRes.json()) as {
    device_auth_id?: string;
    user_code?: string;
    interval?: number | string;
  };

  const intervalS = typeof init.interval === "string" ? Number(init.interval.trim()) : (init.interval ?? 5);
  if (!init.device_auth_id || !init.user_code || !Number.isFinite(intervalS)) {
    throw new Error(`Invalid device code response: ${JSON.stringify(init)}`);
  }

  options.onCode({ userCode: init.user_code, verificationUri: DEVICE_VERIFICATION_URI });

  const deadline = Date.now() + DEVICE_TIMEOUT_S * 1000;
  let pollIntervalMs = intervalS * 1000;

  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw new Error("Login cancelled");

    await new Promise((res) => setTimeout(res, pollIntervalMs));

    const pollRes = await fetchWithTimeout(
      DEVICE_TOKEN_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_auth_id: init.device_auth_id, user_code: init.user_code }),
        signal: options.signal,
      },
      REQUEST_TIMEOUT_MS
    );

    if (pollRes.ok) {
      const json = (await pollRes.json()) as { authorization_code?: string; code_verifier?: string };
      if (!json.authorization_code || !json.code_verifier) {
        throw new Error(`Invalid device token response: ${JSON.stringify(json)}`);
      }
      return exchangeCode(json.authorization_code, json.code_verifier, DEVICE_REDIRECT_URI, options.signal);
    }

    if (pollRes.status === 403 || pollRes.status === 404) {
      continue; // still pending
    }

    const body = await pollRes.text().catch(() => "");
    let errorCode: unknown;
    try { errorCode = (JSON.parse(body) as { error?: { code?: string } | string })?.error; } catch { /* ignore */ }
    const code = typeof errorCode === "object" ? (errorCode as { code?: string })?.code : errorCode;

    if (code === "deviceauth_authorization_pending") continue;
    if (code === "slow_down") { pollIntervalMs += 5000; continue; }

    throw new Error(`Device auth failed (${pollRes.status}): ${body}`);
  }

  throw new Error("Device code login timed out (15 minutes)");
}
