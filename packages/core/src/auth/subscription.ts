import { fetchWithTimeout, REQUEST_TIMEOUT_MS } from "../fetch.js";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { parse } from "yaml";
import { AuthStorage } from "./storage.js";

export type UsageLimitWindow = "5h" | "weekly" | "monthly";

export interface UsageLimitStatus {
  window: UsageLimitWindow;
  limit_usd: number | null;
  used_usd: number;
  remaining_usd: number | null;
  percentage: number | null;
  resets_at: string | null;
}

export interface CurrentSubscription {
  plan: {
    name: string;
    display_name: string;
    price_monthly?: number;
    display_price_monthly?: number | null;
    compare_at_price_monthly?: number | null;
    allowed_tiers: string[];
    fallback_tier?: string | null;
  };
  limits?: Record<UsageLimitWindow, UsageLimitStatus>;
}

export interface MeerCredential {
  token: string;
  source: "api-key" | "login";
}

export async function resolveMeerCredential(): Promise<MeerCredential | null> {
  const envKey = process.env.MEER_API_KEY?.trim();
  if (envKey) {
    return { token: envKey, source: "api-key" };
  }

  const configKey = readConfiguredMeerApiKey();
  if (configKey) {
    return { token: configKey, source: "api-key" };
  }

  const authStorage = new AuthStorage();
  const accessToken = authStorage.getAccessToken();
  if (accessToken) {
    return { token: accessToken, source: "login" };
  }

  return null;
}

export async function hasMeerCredentials(): Promise<boolean> {
  return (await resolveMeerCredential()) !== null;
}

export async function fetchCurrentSubscription(
  apiUrl: string = process.env.MEERAI_API_URL || "https://api.meerai.dev"
): Promise<CurrentSubscription | null> {
  const credential = await resolveMeerCredential();

  if (!credential) {
    return null;
  }

  const response = await fetchWithTimeout(
    `${apiUrl.replace(/\/$/, "")}/api/subscription/current`,
    {
      headers: {
        Authorization: `Bearer ${credential.token}`,
      },
    }
  );

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as {
    subscription?: CurrentSubscription;
  };

  return payload.subscription ?? null;
}

function readConfiguredMeerApiKey(): string | null {
  const configPath = join(homedir(), ".meer", "config.yaml");
  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const parsed = parse(readFileSync(configPath, "utf8")) as {
      meer?: { apiKey?: unknown };
    } | null;
    const apiKey = parsed?.meer?.apiKey;
    return typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : null;
  } catch {
    return null;
  }
}

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "unlimited";
  }
  return `$${Number(value).toFixed(value % 1 === 0 ? 0 : 2)}`;
}
