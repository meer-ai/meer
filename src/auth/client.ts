/**
 * Auth API client for communicating with meer-api backend
 */

import { fetch } from 'undici';
import type { DeviceCodeResponse, TokenResponse, User } from './types.js';

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

    if (!response.ok) {
      const error = await response.json() as any;
      throw new Error(error.message || 'Failed to initialize device code');
    }

    return await response.json() as DeviceCodeResponse;
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

    if (response.status === 400) {
      const error = await response.json() as any;
      if (error.error === 'authorization_pending') {
        return null; // Still pending
      }
      throw new Error(error.message || 'Device code error');
    }

    if (!response.ok) {
      const error = await response.json() as any;
      throw new Error(error.message || 'Failed to poll device code');
    }

    return await response.json() as TokenResponse;
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

    if (!response.ok) {
      const error = await response.json() as any;
      throw new Error(error.message || 'Failed to refresh token');
    }

    return await response.json() as TokenResponse;
  }
}
