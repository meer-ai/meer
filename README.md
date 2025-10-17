<div align="center">

# 🌊 MeerAI
### _Dive deep into your code._

**MeerAI** (from the German word _"Meer"_ — *sea*) is an **open-source, local-first AI CLI** for developers.
Operate entirely on your machine with local models, or connect to hosted providers (Meer Managed, OpenRouter, OpenAI, Anthropic, Gemini, Hugging Face) and Model Context Protocol servers — all from the terminal.

[![License](https://img.shields.io/github/license/meer-ai/meer)](LICENSE)
[![Made with TypeScript](https://img.shields.io/badge/made%20with-TypeScript-blue.svg)](https://www.typescriptlang.org/)
[![Ollama Supported](https://img.shields.io/badge/Ollama-Supported-green.svg)](https://ollama.ai)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![LangChain](https://img.shields.io/badge/Agent-LangChain-blueviolet.svg)](https://python.langchain.com/)

</div>

---

## Overview

MeerAI delivers intelligent assistance **inside your terminal** — no browser tabs, no forced SaaS lock-in.

- **Local-first or cloud-smart** – chat with local [Ollama](https://ollama.ai) models, Meer Managed, or remote APIs (OpenAI, Anthropic, Gemini, Hugging Face, vLLM, TGI)
- **Two agent workflows** – classic streaming agent or LangChain structured agent with 60+ tools and MCP integration
- **Rich TUI experience** – Ink-based terminal UI with timelines, diff previews, approval overlays, slash command palette
- **Workspace-native** – read/edit files, run commands/tests, manage git, scaffold projects, execute semantic search
- **Private by default** – nothing leaves your machine unless you choose a remote provider
- **Extensible** – add providers, tools, MCP servers, or CLI commands without touching core logic

---

## Feature Highlights

| Area | Capabilities |
| ---- | ------------ |
| **Chat (`meer`)** | Interactive TUI with streaming responses, plan tracking, tool timeline, diff previews |
| **One-shot Q&A (`meer ask`)** | Repo-aware answers, optional memory, slash command access, classic/LangChain modes |
| **Reviews & commits** | `meer review`, `meer commit-msg`, inline suggestions, conventional commit support |
| **Toolbox (LangChain)** | 60+ structured tools: read/write, git, run_command, semantic_search, scaffold_project, security_scan, generate_tests, etc. |
| **Slash commands** | `/config`, `/plan`, `/history`, `/remember`, `/forget`, `/shell`, `/mcp` and more |
| **Memory management** | Inspect stats, purge sessions, disable per command |
| **Semantic search & embeddings** | Optional per-project embedding index with local cache or managed backend |
| **MCP support** | Auto-load Model Context Protocol servers via `~/.meer/mcp.yaml` |
| **UI niceties** | Approval overlays, pagination prompts, status bar spinner, command palette |

---

## Quick Start

### 1. Prerequisites
- Node.js **20+**
- Optional: [Ollama](https://ollama.ai) for local LLMs (Mistral, Llama, Phi, Qwen, etc.)

### 2. Install
```bash
git clone https://github.com/meer-ai/meer.git
cd meer
npm install
npm run build
npm link    # or: npm i -g
```

### 3. Configure a provider
```bash
meer setup
```
Select **Ollama**, **Meer Managed**, or another remote provider. Profiles are stored in `~/.meer/config.yaml`.

### 4. Launch the TUI
```bash
meer
```
> Set `MEER_AGENT=langchain` to switch to the LangChain structured agent. Leave unset (or `classic`) for the streaming workflow.

---

## Usage Snippets

### Conversational coding
```bash
MEER_AGENT=langchain meer
```
- Timeline view tracks tool execution.
- Approvals for edits appear as Apply/Skip overlays in the TUI.
- Slash commands (`/plan`, `/history`, `/config`, `/remember`) available inline.

### Repo-aware Q&A
```bash
meer ask "Explain the authentication flow"
meer ask --plan "Draft a migration checklist to Express 5"
```

### Code review & commits
```bash
meer review src/modules/payments
git add .
meer commit-msg --conventional
```

### Memory hygiene
```bash
meer memory stats
meer memory purge --sessions
meer ask --no-memory "Refactor this script"
```

### Toggle agent modes
```bash
MEER_AGENT=classic meer ask "Summarize the CLI bootstrap"
MEER_AGENT=langchain meer ask "Refactor the provider registry"
```

---

## Tracing with LangSmith

MeerAI can emit LangChain traces to [LangSmith](https://smith.langchain.com/) (or a self-hosted LangChain endpoint). Set the following environment variables before starting `meer`:

```bash
export LANGCHAIN_TRACING_V2="true"
export LANGCHAIN_API_KEY="sk-..."        # LangSmith API key
export LANGCHAIN_PROJECT="meer-ai-cli"   # optional, defaults to "default"
# optional for self-hosting:
# export LANGCHAIN_ENDPOINT="https://api.smith.langchain.com"
```

Then launch the CLI with the LangChain agent:

```bash
MEER_AGENT=langchain meer
```

Every conversation turn is streamed to LangSmith with the built-in callback manager. Disable tracing by unsetting `LANGCHAIN_TRACING_V2`.

---

## Agent Workflows

### Classic (`MEER_AGENT=classic` or unset)
- Streaming conversation with incremental tool execution.
- Ideal for quick iteration and conversational coding.
- CLI prompts handle approvals and pagination.

### LangChain (`MEER_AGENT=langchain`)
- Structured agent with LangChain `AgentExecutor` and dynamic toolset.
- 60+ tools defined in `src/agent/tools/langchain.ts`, including git helpers, scaffolding, formatting, testing, semantic search, documentation generators, security scans, etc.
- Model Context Protocol integration via `src/mcp/manager.ts` — automatically loads configured servers and exposes their tools.
- Session tracker monitors plans, tokens, and costs.
- Approvals rendered inside the TUI (no garbled output).

Switch between workflows on demand using the `MEER_AGENT` environment variable.

---

## Configuration

`~/.meer/config.yaml`

```yaml
profile: managed

profiles:
  managed:
    providerType: meer
    model: meer:sonnet
    maxIterations: 6
  ollama-mistral:
    providerType: ollama
    provider:
      name: ollama
      options:
        host: http://localhost:11434
    model: mistral:7b-instruct
    contextEmbedding:
      enabled: true
      maxFileSize: 200_000
  openrouter-claude:
    providerType: openrouter
    provider:
      name: openrouter
      options:
        apiKey: ${OPENROUTER_API_KEY}
    model: openrouter/anthropic/claude-3.5-sonnet
```

Use per-command overrides:
```bash
DEVAI_PROFILE=ollama-mistral meer review src
MEER_AGENT=langchain DEVAI_PROFILE=openrouter-claude meer ask "Generate tests for the CLI"
```

---

## Memory Layout

| Type             | Location                | Description                        |
| ---------------- | ----------------------- | ---------------------------------- |
| Conversations    | `~/.meer/sessions/`     | Rolling session history (JSONL)    |
| Long-term memory | `~/.meer/longterm/`     | Facts, preferences, embeddings     |
| Config           | `~/.meer/config.yaml`   | Provider profiles & agent defaults |
| MCP cache        | `~/.meer/mcp/`          | Cached tool/resource metadata      |

Disable or purge memory whenever needed:
```bash
meer memory purge --longterm
meer ask --no-memory "Explain this file"
```

---

## Directory Overview

```
src/
 ├─ agent/            # Classic + LangChain workflows, prompts, tool adapters
 ├─ commands/         # CLI commands (ask, review, commit, memory…)
 ├─ providers/        # Provider adapters (meer, openrouter, ollama, anthropic, gemini, zai…)
 ├─ tools/            # Core tooling (read/edit, git, run_command, semantic search, MCP bridge)
 ├─ memory/           # Session + long-term storage implementation
 ├─ mcp/              # Model Context Protocol plumbing
 ├─ ui/               # Blessed TUI (chat console, timeline, prompts, status bar)
 └─ utils/            # Shared helpers (token counting, logging, configuration)
```

### Extending MeerAI
- **New tool (LangChain)**: export a function in `src/tools/index.ts`, wrap it in `src/agent/tools/langchain.ts`.
- **New provider**: implement `Provider` interface in `src/providers/` and wire it through `config.ts`.
- **MCP server**: add to `~/.meer/mcp.yaml`; the LangChain agent autoloads it.
- **New CLI command**: create a file in `src/commands/` and register it in `src/cli.ts`.

Run `npm run build` and `npm test` to ensure tooling coverage stays intact.

---

## Contributing

We welcome contributions, bug reports, and ideas!

1. Review the [Code of Conduct](CODE_OF_CONDUCT.md) and [Contributing Guide](CONTRIBUTING.md).
2. Fork the repo and create a branch: `git checkout -b feat/awesome-thing`.
3. Run `npm run build` (and `npm test`) before submitting.
4. Open a PR with the provided [template](.github/PULL_REQUEST_TEMPLATE.md).

Issue templates for bugs/features live under `.github/ISSUE_TEMPLATE/`. The [Security Policy](SECURITY.md) explains how to report vulnerabilities responsibly.

---

## License

MeerAI is open-source under the [MIT License](LICENSE).

---

<div align="center">

### 🌊 *"A sea of models, one interface."*

</div>
