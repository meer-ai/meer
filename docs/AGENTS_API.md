# Sub-Agents API Documentation

## Overview

This document provides API reference for developers working with or extending the sub-agents system in Meer AI.

## Core Modules

### `src/agents/types.ts`

Core TypeScript interfaces and types.

#### `SubAgentDefinition`

Defines a sub-agent's configuration and behavior.

```typescript
interface SubAgentDefinition {
  // Required
  name: string;                    // Unique identifier (lowercase, no spaces)
  description: string;             // Purpose and when to use
  systemPrompt: string;            // Agent's instructions (markdown body)

  // Optional behavior
  model?: 'inherit' | 'sonnet' | 'opus' | 'haiku';
  tools?: string[];                // Tool whitelist (undefined = all tools)
  enabled?: boolean;               // Default: true
  maxIterations?: number;          // Override iteration limit
  temperature?: number;            // Model temperature

  // Metadata
  author?: string;
  version?: string;
  tags?: string[];
}
```

#### `SubAgentResult`

Result returned after sub-agent execution.

```typescript
interface SubAgentResult {
  success: boolean;
  output: string;                  // Full output
  summary?: string;                // Condensed for main context
  metadata: {
    tokensUsed: number;
    duration: number;              // milliseconds
    toolCalls: number;
    toolsUsed: string[];
    errors?: string[];
  };
  error?: string;
}
```

#### `DelegationRequest`

Request to delegate a task to a sub-agent.

```typescript
interface DelegationRequest {
  agentName: string;
  task: string;
  context?: {
    files?: string[];
    cwd?: string;
    metadata?: Record<string, any>;
  };
  options?: DelegationOptions;
}
```

### `src/agents/subagent.ts`

#### `SubAgent`

Represents a running sub-agent instance.

**Constructor**

```typescript
constructor(definition: SubAgentDefinition, config: AgentConfig)
```

**Methods**

```typescript
// Execute a task
async execute(task: string, context?: AgentExecutionContext): Promise<SubAgentResult>

// Get current status
getStatus(): SubAgentStatusInfo

// Get message history
getMessages(): ChatMessage[]

// Abort execution (not fully implemented)
abort(): void

// Get agent definition
getDefinition(): SubAgentDefinition

// Get unique agent ID
getId(): string
```

**Example Usage**

```typescript
import { SubAgent } from './agents/subagent.js';
import type { AgentConfig } from './agent/workflow-v2.js';

const definition = {
  name: 'my-agent',
  description: 'Does something cool',
  systemPrompt: 'You are a helpful assistant...',
};

const config: AgentConfig = {
  provider: myProvider,
  cwd: process.cwd(),
  maxIterations: 10,
};

const agent = new SubAgent(definition, config);
const result = await agent.execute('Analyze the codebase');

if (result.success) {
  console.log('Output:', result.output);
  console.log('Tokens used:', result.metadata.tokensUsed);
}
```

### `src/agents/registry.ts`

#### `AgentRegistry`

Discovers and manages agent definitions from disk.

**Constructor**

```typescript
constructor(cwd: string = process.cwd())
```

**Methods**

```typescript
// Load all agents from disk
async loadAgents(): Promise<void>

// Refresh agents (reload from disk)
async refreshAgents(): Promise<void>

// Get a specific agent by name
getAgent(name: string): SubAgentDefinition | null

// Get all loaded agents
getAllAgents(): SubAgentDefinition[]

// Get only enabled agents
getEnabledAgents(): SubAgentDefinition[]

// Search agents by query
searchAgents(query: string): SubAgentDefinition[]

// Save an agent to disk
async saveAgent(definition: SubAgentDefinition, scope: AgentScope): Promise<void>

// Delete an agent
async deleteAgent(name: string, scope: AgentScope): Promise<void>

// Check if agent exists
hasAgent(name: string): boolean

// Get agent with metadata
getAgentResult(name: string): AgentDiscoveryResult | null
```

**Example Usage**

```typescript
import { AgentRegistry } from './agents/registry.js';

const registry = new AgentRegistry();
await registry.loadAgents();

// List all agents
const agents = registry.getAllAgents();
console.log(`Found ${agents.length} agents`);

// Get a specific agent
const reviewer = registry.getAgent('code-reviewer');
if (reviewer) {
  console.log(reviewer.description);
}

// Search for agents
const securityAgents = registry.searchAgents('security');

// Create a new agent
const newAgent = {
  name: 'my-custom-agent',
  description: 'Custom functionality',
  systemPrompt: 'You are...',
};

await registry.saveAgent(newAgent, 'project');
```

### `src/agents/orchestrator.ts`

#### `AgentOrchestrator`

Central hub for managing and coordinating sub-agents.

**Constructor**

```typescript
constructor(config: AgentConfig)
```

**Methods**

```typescript
// Initialize orchestrator
async initialize(contextPrompt?: string): Promise<void>

// Process a message (delegates to main agent or sub-agents)
async processMessage(
  userMessage: string,
  options?: ProcessMessageOptions
): Promise<string>

// Delegate task to specific sub-agent
async delegateTask(
  agentName: string,
  task: string,
  options?: DelegationOptions
): Promise<SubAgentResult>

// Delegate multiple tasks in parallel
async delegateParallel(
  tasks: ParallelTask[]
): Promise<SubAgentResult[]>

// List available agents
listAvailableAgents(): SubAgentDefinition[]
listEnabledAgents(): SubAgentDefinition[]

// Agent management
async createAgent(definition: SubAgentDefinition, scope: AgentScope): Promise<void>
async removeAgent(name: string, scope: AgentScope): Promise<void>

// Status monitoring
getAgentStatus(id: string): SubAgentStatusInfo | null
getAllActiveAgents(): SubAgentStatusInfo[]

// Search and query
searchAgents(query: string): SubAgentDefinition[]
getAgentDefinition(name: string): SubAgentDefinition | null

// Registry management
async refreshRegistry(): Promise<void>

// Result aggregation
aggregateResults(results: SubAgentResult[]): string
```

**Example Usage**

```typescript
import { AgentOrchestrator } from './agents/orchestrator.js';

const orchestrator = new AgentOrchestrator(config);
await orchestrator.initialize();

// Delegate to a single agent
const result = await orchestrator.delegateTask(
  'code-reviewer',
  'Review the authentication module',
  { timeout: 60000 }
);

// Delegate to multiple agents in parallel
const results = await orchestrator.delegateParallel([
  { agent: 'code-reviewer', task: 'Review for quality' },
  { agent: 'security-auditor', task: 'Check for vulnerabilities' },
]);

// Aggregate results
const summary = orchestrator.aggregateResults(results);
console.log(summary);
```

### `src/agents/tool-filter.ts`

#### `ToolFilter`

Controls which tools a sub-agent can access.

**Constructor**

```typescript
constructor(allowedTools: string[] | undefined, agentName: string)
```

**Methods**

```typescript
// Check if a tool is allowed
isAllowed(toolName: string): boolean

// Validate and throw if not allowed
validateToolCall(toolName: string): void

// Get list of allowed tools
getAllowedTools(): string[] | null

// Check for unrestricted access
isUnrestricted(): boolean
```

**Constants**

```typescript
// All available tools
export const ALL_TOOLS: readonly string[]

// Predefined categories
export const TOOL_CATEGORIES = {
  READ_ONLY: string[],
  WRITE: string[],
  EXECUTE: string[],
  WEB: string[],
  MEMORY: string[],
}
```

**Helper Functions**

```typescript
// Create filter from categories
export function createToolFilterFromCategories(
  categories: (keyof typeof TOOL_CATEGORIES)[],
  agentName: string
): ToolFilter
```

**Example Usage**

```typescript
import { ToolFilter, TOOL_CATEGORIES, createToolFilterFromCategories } from './agents/tool-filter.js';

// Create a filter with specific tools
const filter1 = new ToolFilter(['read_file', 'grep'], 'my-agent');
console.log(filter1.isAllowed('read_file')); // true
console.log(filter1.isAllowed('propose_edit')); // false

// Create filter from categories
const filter2 = createToolFilterFromCategories(['READ_ONLY', 'WEB'], 'web-researcher');
console.log(filter2.isAllowed('google_search')); // true
console.log(filter2.isAllowed('propose_edit')); // false

// Validate tool calls
try {
  filter1.validateToolCall('propose_edit');
} catch (error) {
  console.error(error.message); // Tool not allowed error
}

// Unrestricted access
const filter3 = new ToolFilter(undefined, 'admin-agent');
console.log(filter3.isUnrestricted()); // true
console.log(filter3.isAllowed('any_tool')); // true
```

## Integration with AgentWorkflowV2

The sub-agent system is built on top of `AgentWorkflowV2`, the core agentic workflow engine.

### Creating a SubAgent Instance

```typescript
import { SubAgent } from './agents/subagent.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const definition = registry.getAgent('code-reviewer');

const subAgent = new SubAgent(definition, {
  provider: config.provider,
  cwd: process.cwd(),
  maxIterations: definition.maxIterations || 10,
  sessionTracker: mySessionTracker,
});
```

### Executing Tasks

```typescript
const result = await subAgent.execute(
  'Review the changes in src/auth/login.ts',
  {
    cwd: process.cwd(),
    files: ['src/auth/login.ts'],
    metadata: { branch: 'feature/oauth' },
  }
);
```

## File Format Specification

Agent definitions are stored as Markdown files with YAML frontmatter.

### Required Fields

```markdown
---
name: agent-name
description: What the agent does
---

# Agent system prompt here
```

### Full Example

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
maxIterations: 10
temperature: 0.2
author: Security Team
version: 1.2.0
tags:
  - security
  - audit
  - compliance
---

# Security Auditor

You are a specialized security auditor...

## Responsibilities
...

## Checklist
...
```

## Storage Locations

Agents are discovered from three locations (in priority order):

1. **Project-level**: `.meer/agents/` (highest priority)
2. **User-level**: `~/.meer/agents/` (medium priority)
3. **Built-in templates**: `src/agents/templates/` (lowest priority)

Agents with the same name in higher-priority locations override those in lower-priority locations.

## Error Handling

### Common Error Scenarios

```typescript
// Agent not found
const agent = registry.getAgent('non-existent');
// Returns: null

// Agent disabled
const result = await orchestrator.delegateTask('disabled-agent', 'task');
// Throws: Error('Agent is disabled: disabled-agent')

// Tool not allowed
const filter = new ToolFilter(['read_file'], 'agent');
filter.validateToolCall('propose_edit');
// Throws: Error('Tool "propose_edit" is not allowed...')

// Task timeout
const result = await orchestrator.delegateTask('agent', 'task', {
  timeout: 5000, // 5 seconds
});
// If exceeds timeout, returns SubAgentResult with success: false
```

## Performance Considerations

### Parallel Execution

Use `delegateParallel` for independent tasks:

```typescript
// Sequential (slower)
const review = await orchestrator.delegateTask('code-reviewer', 'Review code');
const security = await orchestrator.delegateTask('security-auditor', 'Check security');

// Parallel (faster)
const results = await orchestrator.delegateParallel([
  { agent: 'code-reviewer', task: 'Review code' },
  { agent: 'security-auditor', task: 'Check security' },
]);
```

### Token Usage

Monitor token consumption via `SubAgentResult.metadata.tokensUsed`:

```typescript
const result = await agent.execute('task');
console.log(`Tokens used: ${result.metadata.tokensUsed}`);
console.log(`Duration: ${result.metadata.duration}ms`);
```

## Extending the System

### Creating Custom Tools

To add custom tools that agents can use, extend the tool system in `src/tools/index.ts` and update `ALL_TOOLS` in `tool-filter.ts`.

### Custom Orchestration Logic

Extend `AgentOrchestrator` to add custom delegation logic:

```typescript
import { AgentOrchestrator } from './agents/orchestrator.js';

class SmartOrchestrator extends AgentOrchestrator {
  async processMessage(message: string, options?: any): Promise<string> {
    // Custom logic to automatically select agents
    if (message.includes('security')) {
      const result = await this.delegateTask('security-auditor', message);
      return result.output;
    }

    // Fall back to main agent
    return super.processMessage(message, options);
  }
}
```

## Testing

### Unit Testing SubAgent

```typescript
import { describe, it, expect } from 'your-test-framework';
import { SubAgent } from './agents/subagent.js';

describe('SubAgent', () => {
  it('should execute a task successfully', async () => {
    const definition = {
      name: 'test-agent',
      description: 'Test agent',
      systemPrompt: 'You are a test agent',
    };

    const agent = new SubAgent(definition, mockConfig);
    const result = await agent.execute('Say hello');

    expect(result.success).toBe(true);
    expect(result.output).toContain('hello');
  });
});
```

### Integration Testing

```typescript
describe('AgentOrchestrator', () => {
  it('should delegate to multiple agents in parallel', async () => {
    const orchestrator = new AgentOrchestrator(config);
    await orchestrator.initialize();

    const results = await orchestrator.delegateParallel([
      { agent: 'agent-1', task: 'Task 1' },
      { agent: 'agent-2', task: 'Task 2' },
    ]);

    expect(results).toHaveLength(2);
    expect(results.every(r => r.success)).toBe(true);
  });
});
```

## Troubleshooting

### Debugging Agent Execution

Enable verbose logging:

```bash
meer --verbose
```

This will show:
- Agent registry loading
- Tool filter validation
- Sub-agent execution details

### Common Issues

**Issue**: Agent not found
**Solution**: Check agent file exists and `loadAgents()` was called

**Issue**: Tool access denied
**Solution**: Add required tool to agent's `tools` list

**Issue**: Agent timeout
**Solution**: Increase timeout in delegation options or reduce task complexity

## Further Reading

- [User Guide](./AGENTS_GUIDE.md) - For end users
- [Implementation Plan](./SUB_AGENTS_IMPLEMENTATION_PLAN.md) - Architecture details
- [AgentWorkflowV2](../src/agent/workflow-v2.ts) - Core workflow engine
