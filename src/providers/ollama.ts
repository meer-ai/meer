import { fetch } from 'undici';
import type { Provider, ChatMessage, ChatOptions, EmbedOptions, ProviderMetadata } from './base.js';

export interface OllamaConfig {
  host: string;
  model: string;
  temperature?: number;
  options?: Record<string, unknown>;
}

export class OllamaProvider implements Provider {
  private config: OllamaConfig;

  constructor(config: OllamaConfig) {
    this.config = {
      host: config.host || process.env.OLLAMA_HOST || 'https://ollama.saifcloud.me',
      model: config.model,
      temperature: config.temperature ?? 0.7,
      options: config.options || {}
    };
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    const response = await this.makeRequest('/api/chat', {
      model: this.config.model,
      messages,
      stream: false,
      options: {
        temperature: options?.temperature ?? this.config.temperature,
        num_ctx: options?.numCtx,
        top_p: options?.topP,
        repeat_penalty: options?.repeatPenalty,
        ...this.config.options,
        ...options
      }
    });

    return response.message?.content || '';
  }

  async *stream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string> {
    const response = await fetch(`${this.config.host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        stream: true,
        options: {
          temperature: options?.temperature ?? this.config.temperature,
          num_ctx: options?.numCtx,
          top_p: options?.topP,
          repeat_penalty: options?.repeatPenalty,
          ...this.config.options,
          ...options
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
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
              if (data.message?.content) {
                yield data.message.content;
              }
              if (data.done) {
                return;
              }
            } catch (e) {
              // Skip invalid JSON lines
              continue;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async embed(texts: string[], options?: EmbedOptions): Promise<number[][]> {
    const embeddings: number[][] = [];
    
    for (const text of texts) {
      const response = await this.makeRequest('/api/embeddings', {
        model: options?.model || this.config.model,
        prompt: text
      });
      
      embeddings.push(response.embedding || []);
    }
    
    return embeddings;
  }

  async metadata(): Promise<ProviderMetadata> {
    try {
      const response = await this.makeRequest('/api/tags', {});
      const models = response.models || [];

      return {
        name: 'Ollama',
        version: '1.0.0',
        capabilities: ['chat', 'stream', 'embed'],
        models: models.map((m: any) => m.name),
        currentModel: this.config.model
      };
    } catch {
      return {
        name: 'Ollama',
        version: '1.0.0',
        capabilities: ['chat', 'stream', 'embed'],
        currentModel: this.config.model
      };
    }
  }

  /**
   * Fetch available models from Ollama
   */
  async listModels(): Promise<Array<{ name: string; size: number; modified: string }>> {
    try {
      const response = await fetch(`${this.config.host}/api/tags`);
      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status}`);
      }

      const data: any = await response.json();
      return data.models || [];
    } catch (error) {
      throw new Error(`Failed to list Ollama models: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Switch to a different model
   */
  switchModel(modelName: string): void {
    this.config.model = modelName;
  }

  /**
   * Get current model name
   */
  getCurrentModel(): string {
    return this.config.model;
  }

  private async makeRequest(endpoint: string, data: any): Promise<any> {
    const response = await fetch(`${this.config.host}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
    }

    return await response.json();
  }
}
