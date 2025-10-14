/**
 * Get the default embedding model for each provider
 */
export function getDefaultEmbeddingModel(providerType: string): string {
  switch (providerType) {
    case 'ollama':
      return 'nomic-embed-text';
    case 'openai':
      return 'text-embedding-3-small';
    case 'openrouter':
      return 'text-embedding-ada-002';
    case 'zai':
      return 'embedding-3'; // Z.ai (ZhiPu AI) embedding model
    case 'gemini':
      return 'text-embedding-004'; // Gemini embedding model
    case 'anthropic':
      // Anthropic doesn't support embeddings
      throw new Error('Anthropic provider does not support embeddings');
    case 'meer':
      // Meer uses underlying provider
      return 'auto';
    default:
      return 'nomic-embed-text'; // Default to Ollama's model
  }
}

/**
 * Check if a provider supports embeddings
 */
export function supportsEmbeddings(providerType: string): boolean {
  return providerType !== 'anthropic';
}
