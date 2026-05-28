import { fetch } from "undici";
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

export async function fetchCurrentSubscription(
  apiUrl: string = process.env.MEERAI_API_URL || "https://api.meerai.dev"
): Promise<CurrentSubscription | null> {
  const authStorage = new AuthStorage();
  const token = authStorage.getAccessToken();

  if (!token) {
    return null;
  }

  const response = await fetch(
    `${apiUrl.replace(/\/$/, "")}/api/subscription/current`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
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

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "unlimited";
  }
  return `$${Number(value).toFixed(value % 1 === 0 ? 0 : 2)}`;
}
