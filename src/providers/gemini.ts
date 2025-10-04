import { fetch } from 'undici';
import type { Provider, ChatMessage, ChatOptions, ProviderMetadata } from './base.js';

export interface GeminiConfig {
  apiKey: string;
  model: string;
  temperature?: number;
}

export class GeminiProvider implements Provider {
  private config: GeminiConfig;
  private baseURL = 'https://generativelanguage.googleapis.com/v1beta';

  constructor(config: GeminiConfig) {
    this.config = {
      apiKey: config.apiKey || process.env.GEMINI_API_KEY || '',
      model: config.model,
      temperature: config.temperature ?? 0.7
    };

    if (!this.config.apiKey) {
      throw new Error('Gemini API key is required. Set GEMINI_API_KEY environment variable or provide it in config.');
    }
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    const contents = this.convertMessages(messages);

    const response = await fetch(
      `${this.baseURL}/models/${this.config.model}:generateContent?key=${this.config.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          generationConfig: {
            temperature: options?.temperature ?? this.config.temperature,
            maxOutputTokens: options?.maxTokens,
            topP: options?.topP
          }
        })
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini API error: ${response.status} ${error}`);
    }

    const data: any = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  async *stream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string> {
    const contents = this.convertMessages(messages);

    const response = await fetch(
      `${this.baseURL}/models/${this.config.model}:streamGenerateContent?key=${this.config.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          generationConfig: {
            temperature: options?.temperature ?? this.config.temperature,
            maxOutputTokens: options?.maxTokens,
            topP: options?.topP
          }
        })
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini API error: ${response.status} ${error}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Failed to get response reader');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim()) {
            try {
              const data = JSON.parse(line);
              const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
              if (text) {
                yield text;
              }
            } catch (e) {
              // Skip invalid JSON
              continue;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async metadata(): Promise<ProviderMetadata> {
    return {
      name: 'Google Gemini',
      version: '1.0.0',
      capabilities: ['chat', 'stream'],
      currentModel: this.config.model
    };
  }

  async listModels(): Promise<Array<{ name: string; id: string }>> {
    try {
      const response = await fetch(
        `${this.baseURL}/models?key=${this.config.apiKey}`
      );

      if (!response.ok) {
        throw new Error('Failed to fetch models');
      }

      const data: any = await response.json();
      const models = data.models || [];

      return models
        .filter((m: any) => m.name.includes('gemini') && m.supportedGenerationMethods?.includes('generateContent'))
        .map((m: any) => ({
          name: m.displayName || m.name.split('/').pop(),
          id: m.name.split('/').pop()
        }));
    } catch (error) {
      // Return common models if API call fails
      return [
        { name: 'Gemini 2.0 Flash', id: 'gemini-2.0-flash-exp' },
        { name: 'Gemini 1.5 Pro', id: 'gemini-1.5-pro' },
        { name: 'Gemini 1.5 Flash', id: 'gemini-1.5-flash' },
        { name: 'Gemini 1.0 Pro', id: 'gemini-1.0-pro' }
      ];
    }
  }

  switchModel(modelName: string): void {
    this.config.model = modelName;
  }

  getCurrentModel(): string {
    return this.config.model;
  }

  private convertMessages(messages: ChatMessage[]): any[] {
    const contents: any[] = [];

    for (const msg of messages) {
      // Gemini uses 'user' and 'model' roles
      const role = msg.role === 'assistant' ? 'model' : msg.role === 'system' ? 'user' : msg.role;

      // Combine system messages with user messages
      if (msg.role === 'system') {
        contents.push({
          role: 'user',
          parts: [{ text: `[System Instructions]\n${msg.content}` }]
        });
      } else {
        contents.push({
          role,
          parts: [{ text: msg.content }]
        });
      }
    }

    return contents;
  }
}
