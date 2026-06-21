<div align="center">

# 🌊 MeerAI
### _Dive deep into your code._

**MeerAI** (from the German word _"Meer"_ — *sea*) is an **open-source, local-first AI CLI** for developers.
Operate entirely on your machine with local models, or connect to hosted providers (Meer Managed, OpenRouter, OpenAI, Anthropic, Gemini, DeepSeek, Z.AI, Ollama) and Model Context Protocol servers — all from the terminal.

[![npm](https://img.shields.io/npm/v/meerai)](https://www.npmjs.com/package/meerai)
[![License](https://img.shields.io/github/license/meer-ai/meer)](LICENSE)
[![CI](https://github.com/meer-ai/meer/actions/workflows/ci.yml/badge.svg)](https://github.com/meer-ai/meer/actions/workflows/ci.yml)
[![Made with TypeScript](https://img.shields.io/badge/made%20with-TypeScript-blue.svg)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

</div>

---

## Overview

MeerAI delivers intelligent assistance **inside your terminal** — no browser tabs, no forced SaaS lock-in.

- **Local-first or cloud-smart** — chat with local [Ollama](https://ollama.ai) models, Meer Managed, or remote APIs (OpenAI, Anthropic, Gemini, OpenRouter, DeepSeek, Z.AI)
- **Structured agent** — a tool-calling loop with a large toolset and Model Context Protocol integration
- **Custom terminal UI** — a differential renderer with live tool timelines, diff previews, approval overlays, and a slash-command palette; native terminal scrollback and text selection/copy
- **Headless modes** — `meer run` / `meer --print` stream plain-text or newline-delimited-JSON events for scripting, CI, and editor/cloud integrations
- **Workspace-native** — read/edit files, run commands and tests, manage git, scaffold projects, run semantic search
- **Private by default** — nothing leaves your machine unless you choose a remote provider
- **Layered & extensible** — a clean package split (core → ai → agent → coding-agent) keeps the generic agent separable from the coding assistant

---

## Feature Highlights

| Area | Capabilities |
| ---- | ------------ |
| **Chat (`meer`)** | Interactive TUI with streaming responses, plan tracking (restored on resume), tool timeline, diff previews |
| **Headless (`meer run`, `meer --print`)** | Non-interactive runs that stream text or JSON events — for CI, scripts, and integrations |
| **One-shot Q&A (`meer ask`)** | Repo-aware answers with optional memory and slash-command access |
| **Reviews & commits** | `meer review`, `meer commit-msg` with conventional-commit support |
| **Toolbox** | 60+ structured tools: read/write/edit, git, run_command, semantic_search, scaffold_project, generate_tests, security_scan, and more |
| **Slash commands** | Built-in palette (`/model`, `/setup`, `/history`, `/plan`, …) plus [custom commands](docs/CUSTOM_SLASH_COMMANDS.md) |
| **Sessions & memory** | Resumable sessions (`--resume`, `--fork`), recent-context loading, per-command memory control |
| **MCP support** | Auto-load Model Context Protocol servers via `~/.meer/mcp.yaml`, with lazy reconnect on server restart |

---

## Quick Start

### Install (recommended)

```bash
npm install -g meerai
```

Requires **Node.js 20+**. Optional: [Ollama](https://ollama.ai) for local models.

### Configure a provider

```bash
meer setup
```

Select **Ollama**, **Meer Managed**, or another remote provider. Profiles are stored in `~/.meer/config.yaml`. For Meer Managed, run `meer login` or set `MEER_API_KEY`.

### Launch

```bash
meer
```

---

## Usage

### Interactive coding
```bash
meer
```
- Live tool timeline and diff previews.
- Edit/command approvals appear as inline overlays (per the project trust mode).
- Slash commands (`/plan`, `/history`, `/config`, `/remember`, …) available inline.
- `?` shows shortcuts. Scroll and copy use your terminal natively.

### Headless / scripting
```bash
# Plain-text, non-interactive run (auto-approves safe actions)
meer run --yes "add a TODO to README.md explaining the project"

# Newline-delimited JSON event stream (for CI / integrations)
meer run --json --yes "fix the failing tests"

# Top-level shorthand for a one-shot prompt
meer --print "summarize the recent changes"
meer --print "summarize the recent changes" --json
```

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

### Sessions & memory
```bash
meer --resume                 # resume the latest session (restores an unfinished plan)
meer --fork <session>         # branch a saved session into a new one
meer memory stats
meer ask --no-memory "Refactor this script"
```

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

Switch profiles per invocation with `meer --profile <name>` (or `DEVAI_PROFILE=<name>`):
```bash
meer --profile ollama-mistral review src
meer --profile openrouter-claude ask "Generate tests for the CLI"
```

---

## Memory Layout

| Type             | Location                | Description                        |
| ---------------- | ----------------------- | ---------------------------------- |
| Conversations    | `~/.meer/sessions/`     | Rolling session history (JSONL)    |
| Long-term memory | `~/.meer/longterm/`     | Facts, preferences, embeddings     |
| Config           | `~/.meer/config.yaml`   | Provider profiles & agent defaults |
| MCP servers      | `~/.meer/mcp.yaml`      | Configured Model Context Protocol servers |

---

## Architecture

MeerAI is a **pnpm workspace monorepo** with an enforced dependency layering, so the generic
agent is cleanly separable from the coding assistant built on top of it:

```
packages/
  @meer-ai/core           HTTP (fetch), auth/OAuth — the base layer, LLM-agnostic
  @meer-ai/ai             LLM I/O: message model, Provider contract, providers, attachments
  @meer-ai/agent          generic agent loop + orchestration types (no tools, no UI, no provider)
  @meer-ai/tui            vendored differential terminal renderer
  @meer-ai/coding-agent   the assistant: tools, slash commands, config, trust, skills, MCP,
                          and the interactive TUI app — owns the `meer` bin
meerai (root)             thin launcher → @meer-ai/coding-agent
```

Dependency rule (lower may not import higher): `core ← ai ← agent ← coding-agent`; `tui` is
independent. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

### Extending MeerAI
- **New tool** — add it under `packages/coding-agent/src/tools/`, wrap it in `packages/coding-agent/src/agent/tools/agent.ts`.
- **New provider** — implement the `Provider` interface in `packages/ai/src/providers/` and wire it through `packages/coding-agent/src/config.ts`.
- **MCP server** — add it to `~/.meer/mcp.yaml`; the agent autoloads it.
- **New CLI command** — create a file in `packages/coding-agent/src/commands/` and register it in `packages/coding-agent/src/cli.ts`.

---

## Development

```bash
git clone https://github.com/meer-ai/meer.git
cd meer
pnpm install
pnpm run build      # build all packages in dependency order
pnpm run check      # typecheck the whole program
pnpm test           # run the verification suite (parallel)
pnpm run dev        # run the CLI from source (tsx, no build)
```

Releases are automated: `pnpm run release` bumps all packages lockstep, runs preflight, tags,
and pushes — GitHub Actions then publishes every package to npm with provenance and cuts a
GitHub Release.

---

## Contributing

We welcome contributions, bug reports, and ideas!

1. Review the [Code of Conduct](CODE_OF_CONDUCT.md) and [Contributing Guide](CONTRIBUTING.md).
2. Fork the repo and create a branch: `git checkout -b feat/awesome-thing`.
3. Run `pnpm run build && pnpm run check && pnpm test` before submitting.
4. Open a PR with the provided [template](.github/PULL_REQUEST_TEMPLATE.md).

Issue templates live under `.github/ISSUE_TEMPLATE/`. The [Security Policy](SECURITY.md) explains how to report vulnerabilities responsibly.

---

## License

MeerAI is open-source under the [MIT License](LICENSE).

---

<div align="center">

### 🌊 *"A sea of models, one interface."*

</div>
