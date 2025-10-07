/**
 * Auth token storage and management
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import type { AuthConfig } from './types.js';

export class AuthStorage {
  private authFilePath: string;

  constructor() {
    const meerDir = join(homedir(), '.meer');
    this.authFilePath = join(meerDir, 'auth.json');
  }

  /**
   * Load auth config from file
   */
  load(): AuthConfig | null {
    if (!existsSync(this.authFilePath)) {
      return null;
    }

    try {
      const content = readFileSync(this.authFilePath, 'utf-8');
      return JSON.parse(content) as AuthConfig;
    } catch (error) {
      console.error('Failed to load auth config:', error);
      return null;
    }
  }

  /**
   * Save auth config to file
   */
  save(config: AuthConfig): void {
    try {
      const dir = dirname(this.authFilePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(this.authFilePath, JSON.stringify(config, null, 2), 'utf-8');
    } catch (error) {
      throw new Error(`Failed to save auth config: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Clear auth config (logout)
   */
  clear(): void {
    if (existsSync(this.authFilePath)) {
      try {
        unlinkSync(this.authFilePath);
      } catch (error) {
        throw new Error(`Failed to clear auth config: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }
  }

  /**
   * Check if user is authenticated
   */
  isAuthenticated(): boolean {
    const config = this.load();
    if (!config || !config.access_token) {
      return false;
    }

    // Check if token is expired
    if (config.expires_at) {
      const expiresAt = new Date(config.expires_at);
      if (expiresAt < new Date()) {
        return false;
      }
    }

    return true;
  }

  /**
   * Get access token
   */
  getAccessToken(): string | null {
    const config = this.load();
    return config?.access_token || null;
  }

  /**
   * Get refresh token
   */
  getRefreshToken(): string | null {
    const config = this.load();
    return config?.refresh_token || null;
  }

  /**
   * Get current user
   */
  getUser(): AuthConfig['user'] | null {
    const config = this.load();
    return config?.user || null;
  }
}
