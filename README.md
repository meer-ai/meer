<div align="center">

# 🌊 **MeerAI**
### _Dive deep into your code._

**MeerAI** (from the German word _“Meer”_ — *sea*) is an **open-source, local-first AI CLI** for developers.  
It connects to your **local Ollama models** or remote providers like **OpenAI, Anthropic, Gemini, and Hugging Face**,  
letting you chat with your code, review changes, and craft commits — all from the terminal.

[![License](https://img.shields.io/github/license/meerai/meer)](LICENSE)
[![Made with TypeScript](https://img.shields.io/badge/made%20with-TypeScript-blue.svg)](https://www.typescriptlang.org/)
[![Ollama Supported](https://img.shields.io/badge/Ollama-Supported-green.svg)](https://ollama.ai)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

</div>

---

## 🚀 Overview

MeerAI brings intelligent developer assistance **to your command line** — no cloud lock-in, no tracking, no limits.

- 🧠 **Local-first** — runs entirely offline with [Ollama](https://ollama.ai)
- 🌍 **Model-agnostic** — plug in OpenAI, Anthropic, Gemini, Hugging Face, or BYOK (vLLM, TGI)
- 💬 **Conversational CLI** — chat, ask, review, commit directly from your terminal
- 🪶 **Lightweight** — zero dependencies beyond Node.js
- 🔒 **Private by design** — nothing leaves your machine (unless you choose to sync)
- 🧩 **Extensible** — add your own models, tools, or providers

---

## 🧭 Commands

| Command | Description |
|----------|-------------|
| `meer` | Interactive chat session with live context |
| `meer ask "<prompt>"` | One-shot Q&A with repo context |
| `meer commit-msg` | Generate commit messages from staged diffs |
| `meer review [path]` | Review code and suggest improvements |
| `meer memory` | View or clear local memory |
| `meer tide pull/push` _(coming soon)_ | Sync sessions & templates to backend |

---

## ⚙️ Installation

### 1️⃣ Prerequisites
- Node.js **20+**
- [Ollama](https://ollama.ai) (for local models like Mistral, Llama, Phi, Qwen)

### 2️⃣ Clone & setup
```bash
git clone https://github.com/meer-ai/meer.git
cd meer
npm install
npm run build
npm link        # or npm i -g
````

### 3️⃣ Verify

```bash
meer --help
```

---

## 🌊 Example Usage

### Ask about your code

```bash
meer ask "Explain how the database layer handles transactions."
```

### Generate a commit message

```bash
git add .
meer commit-msg
```

### Review code in current directory

```bash
meer review .
```

---

## 🧠 Local Memory

MeerAI remembers context between runs — stored privately on your device.

| Type             | Location                | Description                        |
| ---------------- | ----------------------- | ---------------------------------- |
| Conversations    | `~/.meer/sessions/`   | Rolling session history (JSONL)    |
| Long-term memory | `~/.meer/longterm/`   | Facts, preferences, embeddings     |
| Config           | `~/.meer/config.yaml` | Provider profiles & model defaults |

You can disable memory any time:

```bash
meer ask --no-memory "Refactor this script"
meer memory purge
```

---

## 🗂️ Configuration

**`~/.meerai/config.yaml`**

```yaml
profile: mistral7b

profiles:
  mistral7b:
    provider: ollama
    model: mistral:7b-instruct
    temperature: 0.2

  phi3:
    provider: ollama
    model: phi3:3.8b

  llama3:
    provider: ollama
    model: llama3.2:3b

  qwen:
    provider: ollama
    model: qwen2.5:3b-instruct
```

Switch profiles on the fly:

```bash
DEVAI_PROFILE=phi3 meer ask "Summarize this file"
```

---

## 🧩 Extending MeerAI

MeerAI is modular — add new capabilities under:

```
src/
 ├─ providers/    # Model connectors
 ├─ commands/     # CLI commands
 ├─ memory/       # Local memory store
 └─ context/      # Code context + embeddings
```

Example new command:

```bash
meer dive  # deep multi-file analysis
```

Example new provider:

```bash
src/providers/gemini.ts
src/providers/anthropic.ts
```

---

## 🌐 Roadmap

| Stage   | Goal                                           |
| ------- | ---------------------------------------------- |
| ✅ v0.1  | CLI foundation, Ollama adapter, local memory   |
| 🧩 v0.2 | OpenAI-compatible + Hugging Face providers     |
| 🌍 v0.3 | Sync backend (optional self-hosted API + DB)   |
| 🪶 v0.4 | Plug-in system for custom commands             |
| 🌅 v1.0 | Community templates, cloud-sync, GUI dashboard |

---

## 🤝 Contributing

Contributions, bug reports, and feature ideas are all welcome!

1. Fork the repo
2. Create your branch: `git checkout -b feature/your-feature`
3. Commit your changes
4. Open a PR 🎉

Please check out [CONTRIBUTING.md](CONTRIBUTING.md) for details.

---

## 🛡️ License

MeerAI is open-source under the [MIT License](LICENSE).

---

<div align="center">

### 🌊 *“A sea of models, one interface.”*

</div>
