/**
 * Auth API client for communicating with meer-api backend
 */

import { fetch } from 'undici';
import type { Response } from 'undici';
import type { DeviceCodeResponse, TokenResponse } from './types.js';

export class AuthClient {
  private apiUrl: string;

  constructor(apiUrl: string = process.env.MEERAI_API_URL || 'https://api.meerai.dev') {
    this.apiUrl = apiUrl;
  }

  /**
   * Initialize device code flow
   */
  async initializeDeviceCode(): Promise<DeviceCodeResponse> {
    const response = await fetch(`${this.apiUrl}/auth/device/code`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    const payload = await parseJsonResponse(response);

    if (!response.ok) {
      throw new Error(payload?.message || formatUnexpected(payload));
    }

    return payload as DeviceCodeResponse;
  }

  /**
   * Poll device code status
   */
  async pollDeviceCode(deviceCode: string): Promise<TokenResponse | null> {
    const response = await fetch(`${this.apiUrl}/auth/device/poll`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ device_code: deviceCode }),
    });

    const payload = await parseJsonResponse(response);

    if (response.status === 400) {
      if (payload?.error === 'authorization_pending') {
        return null; // Still pending
      }
      throw new Error(payload?.message || formatUnexpected(payload));
    }

    if (!response.ok) {
      throw new Error(payload?.message || 'Failed to poll device code');
    }

    return payload as TokenResponse;
  }

  /**
   * Refresh access token
   */
  async refreshToken(refreshToken: string): Promise<TokenResponse> {
    const response = await fetch(`${this.apiUrl}/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    const payload = await parseJsonResponse(response);

    if (!response.ok) {
      throw new Error(payload?.message || 'Failed to refresh token');
    }

    return payload as TokenResponse;
  }
}

async function parseJsonResponse(response: Response): Promise<any | null> {
  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `Unexpected response from server${
        response.url ? ` (${response.url})` : ''
      }: ${text}`,
    );
  }
}

function formatUnexpected(payload: unknown): string {
  if (!payload) {
    return 'Unexpected response from authentication service';
  }

  if (typeof payload === 'string') {
    return payload;
  }

  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}
