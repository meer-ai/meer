import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { OllamaProvider } from './providers/ollama.js';
import { OpenAIProvider } from './providers/openai.js';
import { GeminiProvider } from './providers/gemini.js';
import type { Provider } from './providers/base.js';

const ConfigSchema = z.object({
  provider: z.enum(['ollama', 'openai', 'gemini']),
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
  }).optional()
});

export type Config = z.infer<typeof ConfigSchema>;

export interface LoadedConfig {
  provider: Provider;
  providerType: string;
  model: string;
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

    default:
      throw new Error(`Unsupported provider: ${config.provider}`);
  }

  return {
    provider,
    providerType: config.provider,
    model: defaultModel
  };
}
