# Sub-Agents System

Multi-agent orchestration for specialized task execution in Meer AI.

## Overview

The sub-agents system enables:
- **Task Parallelization**: Run multiple specialized agents simultaneously
- **Context Isolation**: Each agent maintains independent conversation context
- **Tool Access Control**: Restrict agents to specific tools for safety
- **Specialized Expertise**: Create agents focused on specific domains

## Quick Start

### List Available Agents

```bash
meer agents
```

### Use Built-in Agents

Three specialized agents are included:

1. **code-reviewer**: Reviews code for quality, security, and best practices
2. **debugger**: Analyzes errors and finds root causes
3. **test-writer**: Generates unit and integration tests

```bash
# View agent details
meer agents show code-reviewer
```

### Create Custom Agents

```bash
# Interactive creation wizard
meer agents create

# Create in user scope (available across all projects)
meer agents create --scope user
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     AgentOrchestrator                        │
│  - Task decomposition                                         │
│  - Sub-agent coordination                                     │
│  - Result aggregation                                         │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ├──────────────┬──────────────┬──────────────┐
                 ▼              ▼              ▼              ▼
         ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
         │  SubAgent 1  │ │  SubAgent 2  │ │  SubAgent N  │
         │              │ │              │ │              │
         │ - Isolated   │ │ - Isolated   │ │ - Isolated   │
         │   context    │ │   context    │ │   context    │
         │ - Tool access│ │ - Tool access│ │ - Tool access│
         │   control    │ │   control    │ │   control    │
         └──────────────┘ └──────────────┘ └──────────────┘
```

## Module Structure

```
src/agents/
├── types.ts              # TypeScript interfaces
├── subagent.ts           # SubAgent class (isolated execution)
├── registry.ts           # AgentRegistry (discovery & management)
├── orchestrator.ts       # AgentOrchestrator (coordination)
├── tool-filter.ts        # Tool access control
├── index.ts              # Module exports
├── templates/            # Built-in agent templates
│   ├── code-reviewer.md
│   ├── debugger.md
│   └── test-writer.md
└── README.md             # This file
```

## Core Components

### SubAgent

Isolated agent instance with independent context and lifecycle.

```typescript
const agent = new SubAgent(definition, config);
const result = await agent.execute('Analyze the codebase');
```

See: [subagent.ts](./subagent.ts)

### AgentRegistry

Discovers and manages agent definitions from filesystem.

```typescript
const registry = new AgentRegistry();
await registry.loadAgents();

const agents = registry.getAllAgents();
const reviewer = registry.getAgent('code-reviewer');
```

See: [registry.ts](./registry.ts)

### AgentOrchestrator

Central hub for coordinating multiple sub-agents.

```typescript
const orchestrator = new AgentOrchestrator(config);
await orchestrator.initialize();

// Delegate to single agent
const result = await orchestrator.delegateTask('code-reviewer', 'Review code');

// Parallel execution
const results = await orchestrator.delegateParallel([
  { agent: 'code-reviewer', task: 'Review for quality' },
  { agent: 'security-auditor', task: 'Check security' },
]);
```

See: [orchestrator.ts](./orchestrator.ts)

### ToolFilter

Controls which tools each agent can access.

```typescript
const filter = new ToolFilter(['read_file', 'grep'], 'code-reviewer');
filter.validateToolCall('read_file'); // ✅ Allowed
filter.validateToolCall('propose_edit'); // ❌ Throws error
```

See: [tool-filter.ts](./tool-filter.ts)

## Agent Definition Format

Agents are defined as Markdown files with YAML frontmatter:

```markdown
---
name: security-auditor
description: Audits code for security vulnerabilities
model: inherit
tools:
  - read_file
  - grep
  - run_command
enabled: true
tags:
  - security
  - audit
---

# Security Auditor

You are a specialized security auditor focused on finding vulnerabilities.

## Your Responsibilities

1. Identify common security issues
2. Ensure secure coding patterns
3. Check compliance with security standards
```

## Storage Locations

Agents are discovered from (in priority order):

1. **Project**: `.meer/agents/*.md` (highest priority)
2. **User**: `~/.meer/agents/*.md`
3. **Built-in**: `src/agents/templates/*.md` (lowest priority)

Agents in higher-priority locations override those with the same name in lower-priority locations.

## Tool Categories

Predefined tool categories for easy agent creation:

- **READ_ONLY**: Read files, search, analyze
- **WRITE**: Edit and modify files
- **EXECUTE**: Run shell commands
- **WEB**: Search and fetch from internet
- **MEMORY**: Save and load memory

```typescript
import { createToolFilterFromCategories } from './tool-filter.js';

const filter = createToolFilterFromCategories(['READ_ONLY', 'WEB'], 'researcher');
```

## CLI Commands

### Management

```bash
# List all agents
meer agents
meer agents list

# Show only enabled agents
meer agents list --enabled-only

# View agent details
meer agents show <name>
```

### Creation & Editing

```bash
# Create new agent (interactive)
meer agents create

# Create in specific scope
meer agents create --scope project
meer agents create --scope user
```

### Enable/Disable

```bash
# Disable temporarily
meer agents disable <name>

# Re-enable
meer agents enable <name>
```

### Deletion

```bash
# Delete agent
meer agents delete <name> --scope project
meer agents delete <name> --scope user
```

## TypeScript API

### Import

```typescript
import {
  // Classes
  SubAgent,
  AgentRegistry,
  AgentOrchestrator,
  ToolFilter,

  // Types
  SubAgentDefinition,
  SubAgentResult,
  DelegationRequest,
  ParallelTask,

  // Utilities
  TOOL_CATEGORIES,
  ALL_TOOLS,
  createToolFilterFromCategories,
} from './agents/index.js';
```

### Example Usage

```typescript
// Create orchestrator
const orchestrator = new AgentOrchestrator(config);
await orchestrator.initialize();

// List agents
const agents = orchestrator.listEnabledAgents();
console.log(`Found ${agents.length} agents`);

// Delegate task
const result = await orchestrator.delegateTask(
  'code-reviewer',
  'Review the authentication module',
  { timeout: 60000 }
);

if (result.success) {
  console.log(result.output);
  console.log(`Tokens: ${result.metadata.tokensUsed}`);
  console.log(`Duration: ${result.metadata.duration}ms`);
}
```

## Testing

Unit tests (TODO):

```bash
npm test -- src/agents
```

## Implementation Status

✅ **Phase 1: Foundation**
- TypeScript interfaces
- SubAgent class
- AgentRegistry
- Default templates

✅ **Phase 2: Orchestration**
- AgentOrchestrator
- Task delegation
- Tool access control

✅ **Phase 3: Parallel Execution**
- Multi-agent coordination
- Status monitoring
- Result aggregation

✅ **Phase 4: CLI Interface**
- `/agents` command
- Interactive creation
- Agent management

🚧 **Phase 5: Integration** (In Progress)
- Automatic delegation from main chat
- Agent recommendations
- Performance metrics

## Documentation

- **[User Guide](../../docs/AGENTS_GUIDE.md)**: For end users creating and using agents
- **[API Documentation](../../docs/AGENTS_API.md)**: For developers extending the system
- **[Implementation Plan](../../docs/SUB_AGENTS_IMPLEMENTATION_PLAN.md)**: Complete technical architecture

## Contributing

When adding new features:

1. Update TypeScript interfaces in `types.ts`
2. Add unit tests (when testing is set up)
3. Update documentation
4. Follow existing code patterns

## Future Enhancements

Planned features:

- [ ] Automatic agent selection based on task
- [ ] Agent-to-agent communication
- [ ] Agent chaining workflows
- [ ] Performance metrics and dashboards
- [ ] Agent marketplace/sharing
- [ ] Visual agent builder UI

## License

MIT - Part of Meer AI
