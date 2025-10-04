# Meerai 🌊

> Your AI companion that flows like the sea

A production-ready, model-agnostic developer CLI with a pluggable provider layer. Built with TypeScript and designed for Windows/macOS/Linux with Node 20+.

## Features

- 🤖 **Multi-Provider Support**: Ollama, OpenAI, and Google Gemini
- 🛠️ **Agentic Workflow**: Tool-based system with file reading, editing, and creation
- 💬 **Interactive Chat**: Streaming responses with conversation history
- 📋 **Task Tracking**: Auto-generated TODO lists for multi-step tasks
- 📊 **Edit Summaries**: Comprehensive summaries after file modifications
- ⚡ **Slash Commands**: Quick access to provider/model switching and more
- 🎯 **Multiple Profiles**: Switch between different AI providers and models seamlessly

## Quick Start

### Installation

#### From Source (Development)

```bash
# Clone the repository
git clone https://github.com/moesaif/meerai.git
cd meerai

# Install dependencies
npm install

# Build the project
npm run build

# Link globally for local development
npm link

# Now you can use meerai from anywhere
meerai
```

#### From npm (Coming Soon)

```bash
# Install globally (once published)
npm install -g meerai

# Or use npx
npx meerai ask "What does this code do?"
```

### Configuration

On first run, the CLI creates `~/.meerai/config.yaml` with default configuration:

```yaml
provider: ollama
model: mistral:7b-instruct
temperature: 0.7

ollama:
  host: "http://127.0.0.1:11434"
  options: {}

openai:
  apiKey: ""  # Set via OPENAI_API_KEY env var
  baseURL: "https://api.openai.com/v1"
  organization: ""

gemini:
  apiKey: ""  # Set via GEMINI_API_KEY env var
```

### Setup by Provider

#### Ollama (Local)

1. Install [Ollama](https://ollama.ai/)
2. Pull a model: `ollama pull mistral:7b-instruct`
3. Update the `host` in config if needed

#### OpenAI

1. Get API key from [OpenAI Platform](https://platform.openai.com/api-keys)
2. Set environment variable: `export OPENAI_API_KEY=sk-...`
3. Or add `apiKey` to profile in config

#### Google Gemini

1. Get API key from [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Set environment variable: `export GEMINI_API_KEY=...`
3. Or add `apiKey` to profile in config

## Commands

### Ask Questions

```bash
# Ask about your codebase with context
meerai ask "Explain this repo's database layer"

# Ask without context
meerai ask "What is TypeScript?" --no-context
```

### Interactive Chat

```bash
# Start an interactive session (default command)
meerai

# Or explicitly
meerai chat
```

#### Slash Commands

When in chat mode, type `/` to access these commands:

- `/provider` - Switch between Ollama, OpenAI, and Gemini
- `/model` - Switch to a different model within current provider
- `/init` - Create AGENTS.md for project context
- `/help` - Show help message
- `/exit` - Exit chat session

**Example:**
```
You: /
? Select a slash command:
  1) /init - Create AGENTS.md
  2) /provider - Switch AI provider
  3) /model - Switch AI model
  4) /help - Show help
  5) /exit - Exit
```

### Generate Commit Messages

```bash
# Stage your changes first
git add .

# Generate commit message
meerai commit-msg
```

### Code Review

```bash
# Review current directory
meerai review

# Review specific file
meerai review src/utils.ts

# Review specific directory
meerai review src/components
```

## Configuration

### Environment Variables

- `OPENAI_API_KEY`: OpenAI API key
- `GEMINI_API_KEY`: Google Gemini API key
- `OLLAMA_HOST`: Ollama server URL (default: http://127.0.0.1:11434)

### Configuration Options

```yaml
provider: ollama              # Active provider: ollama, openai, or gemini
model: mistral:7b-instruct   # Model to use with active provider
temperature: 0.7             # 0.0-1.0

ollama:
  host: "http://localhost:11434"
  options:
    num_ctx: 4096           # Context window
    top_p: 0.9              # Nucleus sampling
    repeat_penalty: 1.1     # Repetition penalty

openai:
  apiKey: ""                # Or use OPENAI_API_KEY env var
  baseURL: "https://api.openai.com/v1"
  organization: ""

gemini:
  apiKey: ""                # Or use GEMINI_API_KEY env var
```

## Ollama Performance Tips

For better performance with Ollama:

```bash
# Set environment variables
export OLLAMA_NUM_PARALLEL=1
export OLLAMA_KEEP_ALIVE=2m

# Or in your shell profile
echo 'export OLLAMA_NUM_PARALLEL=1' >> ~/.bashrc
echo 'export OLLAMA_KEEP_ALIVE=2m' >> ~/.bashrc
```

## Context Collection

The CLI automatically collects relevant code context by:

1. **File Discovery**: Scans for `.ts`, `.tsx`, `.js`, `.py`, `.go`, `.sql`, `.md`, `.json`, `.yaml` files
2. **Smart Filtering**: Ignores `node_modules`, `.git`, `dist`, `build`, etc.
3. **Chunking**: Splits large files into 1200-character chunks with 200-character overlap
4. **Embedding**: Uses provider embeddings to find relevant chunks
5. **Top-K Retrieval**: Returns the 6 most relevant chunks for context

## Development

### Project Structure

```
devai-cli/
├── src/
│   ├── index.ts              # Entry point
│   ├── cli.ts                # Commander setup
│   ├── config.ts             # Config management
│   ├── context/
│   │   └── collect.ts        # RAG functionality
│   ├── providers/
│   │   ├── base.ts           # Provider interface
│   │   └── ollama.ts         # Ollama adapter
│   └── commands/
│       ├── ask.ts            # Ask command
│       ├── chat.ts           # Chat command
│       ├── commitMsg.ts      # Commit message
│       └── review.ts         # Code review
├── package.json
├── tsconfig.json
└── README.md
```

### Building

```bash
# Install dependencies
npm install

# Development
npm run dev

# Build
npm run build

# Test
npm test
```

### Adding New Providers

1. Create a new provider in `src/providers/`
2. Implement the `Provider` interface
3. Add provider type to config schema
4. Update config loader

Example provider stub:

```typescript
// src/providers/openai.ts
export class OpenAIProvider implements Provider {
  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    // Implementation
  }
  
  async *stream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string> {
    // Implementation
  }
  
  async embed?(texts: string[], options?: EmbedOptions): Promise<number[][]> {
    // Implementation
  }
}
```

## Extension Points

### TODO: Future Enhancements

- [ ] **OpenAI Provider**: Add OpenAI-compatible provider (vLLM/TGI/Groq)
- [ ] **Tool Protocol**: Model tool calling with CLI execution
- [ ] **JSON Output**: `--json` flag for CI integration
- [ ] **Custom Models**: Support for custom model endpoints
- [ ] **Advanced RAG**: Vector database integration
- [ ] **Code Actions**: Automated code fixes and refactoring

### Provider Interface

```typescript
interface Provider {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
  stream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string>;
  embed?(texts: string[], options?: EmbedOptions): Promise<number[][]>;
  metadata?(): Promise<ProviderMetadata>;
}
```

## Troubleshooting

### Common Issues

1. **Ollama not running**: Ensure Ollama is running on the correct port
2. **Model not found**: Pull the model with `ollama pull <model-name>`
3. **Context too large**: Use `--no-context` for large repositories
4. **Slow responses**: Check Ollama performance settings

### Debug Mode

```bash
# Enable debug logging
DEBUG=meerai* meerai ask "test"
```

## License

MIT License - see LICENSE file for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## Support

- GitHub Issues: [Report bugs and request features](https://github.com/moesaif/meerai/issues)
- Documentation: [Full documentation](https://github.com/moesaif/meerai/wiki)
