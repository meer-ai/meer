import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { OllamaProvider } from './providers/ollama.js';
import { OpenAIProvider } from './providers/openai.js';
import { GeminiProvider } from './providers/gemini.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenRouterProvider } from './providers/openrouter.js';
import { MeerProvider } from './providers/meer.js';
import type { Provider } from './providers/base.js';

const ConfigSchema = z.object({
  provider: z.enum(['ollama', 'openai', 'gemini', 'anthropic', 'openrouter', 'meer']),
  model: z.string().optional(),
  temperature: z.number().optional(),
  // Ollama-specific
  ollama: z.object({
    host: z.string().optional(),
    options: z.record(z.unknown()).optional()
  }).optional(),
  // OpenAI-specific
  openai: z.object({
    apiKey: z.string().optional(),
    baseURL: z.string().optional(),
    organization: z.string().optional()
  }).optional(),
  // Gemini-specific
  gemini: z.object({
    apiKey: z.string().optional()
  }).optional(),
  // Anthropic-specific
  anthropic: z.object({
    apiKey: z.string().optional(),
    baseURL: z.string().optional(),
    maxTokens: z.number().optional()
  }).optional(),
  // OpenRouter-specific
  openrouter: z.object({
    apiKey: z.string().optional(),
    baseURL: z.string().optional(),
    siteName: z.string().optional(),
    siteUrl: z.string().optional()
  }).optional(),
  // Meer provider (managed)
  meer: z.object({
    apiKey: z.string().optional(),
    apiUrl: z.string().optional()
  }).optional(),
  context: z.object({
    autoCollect: z.boolean().optional(),
    embedding: z.object({
      enabled: z.boolean().optional(),
      dimensions: z.number().optional(),
      maxFileSize: z.number().optional()
    }).optional()
  }).optional()
});

export type Config = z.infer<typeof ConfigSchema>;

export interface LoadedConfig {
  provider: Provider;
  providerType: string;
  model: string;
  retry?: {
    attempts: number;
    delayMs: number;
    backoffFactor: number;
  };
  contextEmbedding?: {
    enabled: boolean;
    dimensions: number;
    maxFileSize: number;
  };
  autoCollectContext?: boolean;
}

export function configExists(): boolean {
  const configPath = join(homedir(), '.meer', 'config.yaml');
  return existsSync(configPath);
}

export function loadConfig(): LoadedConfig {
  const configPath = join(homedir(), '.meer', 'config.yaml');

  let config: Config;

  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, 'utf-8');
      const parsed = parse(content);
      config = ConfigSchema.parse(parsed);
    } catch (error) {
      console.error('Error parsing config file:', error);
      throw new Error('Invalid config file format');
    }
  } else {
    // Create default config
    config = {
      provider: 'ollama',
      model: 'mistral:7b-instruct',
      temperature: 0.7,
      ollama: {
        host: 'http://127.0.0.1:11434',
        options: {}
      },
      openai: {
        apiKey: '', // Set via OPENAI_API_KEY env var
        baseURL: 'https://api.openai.com/v1',
        organization: ''
      },
      gemini: {
        apiKey: '' // Set via GEMINI_API_KEY env var
      },
      anthropic: {
        apiKey: '', // Set via ANTHROPIC_API_KEY env var
        baseURL: 'https://api.anthropic.com',
        maxTokens: 4096
      },
      openrouter: {
        apiKey: '', // Set via OPENROUTER_API_KEY env var
        baseURL: 'https://openrouter.ai/api',
        siteName: 'MeerAI CLI',
        siteUrl: 'https://github.com/anthropics/meer'
      },
      meer: {
        apiKey: '', // Set via MEER_API_KEY env var
        apiUrl: process.env.MEERAI_API_URL || 'https://api.meerai.dev'
      },
      context: {
        autoCollect: false,
        embedding: {
          enabled: false,
          dimensions: 256,
          maxFileSize: 200_000
        }
      }
    };

    // Create config directory and file
    try {
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, stringify(config));
      console.log(`Created default config at ${configPath}`);
    } catch (error) {
      console.warn('Could not create default config file:', error);
    }
  }

  let provider: Provider;
  let defaultModel: string;

  switch (config.provider) {
    case 'ollama':
      defaultModel = config.model || 'mistral:7b-instruct';
      provider = new OllamaProvider({
        host: config.ollama?.host || 'http://127.0.0.1:11434',
        model: defaultModel,
        temperature: config.temperature,
        options: config.ollama?.options
      });
      break;

    case 'openai':
      defaultModel = config.model || 'gpt-4o';
      provider = new OpenAIProvider({
        apiKey: config.openai?.apiKey || process.env.OPENAI_API_KEY || '',
        baseURL: config.openai?.baseURL,
        model: defaultModel,
        temperature: config.temperature,
        organization: config.openai?.organization
      });
      break;

    case 'gemini':
      defaultModel = config.model || 'gemini-2.0-flash-exp';
      provider = new GeminiProvider({
        apiKey: config.gemini?.apiKey || process.env.GEMINI_API_KEY || '',
        model: defaultModel,
        temperature: config.temperature
      });
      break;

    case 'anthropic':
      defaultModel = config.model || 'claude-3-5-sonnet-20241022';
      provider = new AnthropicProvider({
        apiKey: config.anthropic?.apiKey || process.env.ANTHROPIC_API_KEY || '',
        baseURL: config.anthropic?.baseURL,
        model: defaultModel,
        temperature: config.temperature,
        maxTokens: config.anthropic?.maxTokens
      });
      break;

    case 'openrouter':
      defaultModel = config.model || 'anthropic/claude-3.5-sonnet';
      provider = new OpenRouterProvider({
        apiKey: config.openrouter?.apiKey || process.env.OPENROUTER_API_KEY || '',
        baseURL: config.openrouter?.baseURL,
        model: defaultModel,
        temperature: config.temperature,
        siteName: config.openrouter?.siteName,
        siteUrl: config.openrouter?.siteUrl
      });
      break;

    case 'meer':
      defaultModel = config.model || 'auto';
      provider = new MeerProvider({
        apiKey: config.meer?.apiKey || process.env.MEER_API_KEY || '',
        apiUrl: config.meer?.apiUrl || process.env.MEERAI_API_URL || 'https://api.meerai.dev',
        model: defaultModel,
        temperature: config.temperature
      });
      break;

    default:
      throw new Error(`Unsupported provider: ${config.provider}`);
  }

  return {
    provider,
    providerType: config.provider,
    model: defaultModel,
    retry: {
      attempts: 3,
      delayMs: 1000,
      backoffFactor: 2,
    },
    autoCollectContext: config.context?.autoCollect ?? false,
    contextEmbedding: {
      enabled: config.context?.embedding?.enabled ?? false,
      dimensions: config.context?.embedding?.dimensions ?? 256,
      maxFileSize: config.context?.embedding?.maxFileSize ?? 200_000,
    },
  };
}
