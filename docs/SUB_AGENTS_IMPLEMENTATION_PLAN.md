# Sub-Agents Implementation Plan for Meer AI

## Executive Summary

This document outlines the implementation plan for a multi-agent system in Meer AI, inspired by Claude Code's sub-agent architecture. The system will enable task parallelization, better context management, and specialized agent capabilities.

---

## 1. Architecture Overview

### 1.1 Core Components

```
┌─────────────────────────────────────────────────────────────┐
│                     Orchestrator Agent                       │
│  - Main conversation context                                 │
│  - Task decomposition                                        │
│  - Sub-agent coordination                                    │
│  - Result aggregation                                        │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ├──────────────┬──────────────┬──────────────┐
                 ▼              ▼              ▼              ▼
         ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ...
         │  Sub-Agent 1 │ │  Sub-Agent 2 │ │  Sub-Agent N │
         │              │ │              │ │              │
         │ - Isolated   │ │ - Isolated   │ │ - Isolated   │
         │   context    │ │   context    │ │   context    │
         │ - Specialized│ │ - Specialized│ │ - Specialized│
         │   tools      │ │   tools      │ │   tools      │
         │ - Custom     │ │ - Custom     │ │ - Custom     │
         │   prompt     │ │   prompt     │ │   prompt     │
         └──────────────┘ └──────────────┘ └──────────────┘
```

### 1.2 File Structure

```
src/
├── agents/
│   ├── orchestrator.ts          # Main orchestrator logic
│   ├── subagent.ts              # SubAgent class
│   ├── registry.ts              # Agent registry & discovery
│   ├── types.ts                 # TypeScript interfaces
│   └── templates/               # Default agent templates
│       ├── code-reviewer.md
│       ├── debugger.md
│       ├── test-writer.md
│       ├── documentation.md
│       └── refactorer.md
├── commands/
│   └── agents.ts                # /agents slash command
└── ui/
    └── agentPanel.tsx           # UI for agent management
```

### 1.3 Storage Structure

```
.meer/
├── agents/                      # Project-level agents (highest priority)
│   ├── code-reviewer.md
│   ├── custom-agent.md
│   └── ...
│
~/.meer/
├── agents/                      # User-level agents (lower priority)
│   ├── data-scientist.md
│   └── ...
```

---

## 2. Agent Definition Format

### 2.1 Markdown with YAML Frontmatter

```markdown
---
name: code-reviewer
description: Reviews code for quality, security, and best practices. Use PROACTIVELY after code changes.
model: inherit
tools:
  - Read
  - Grep
  - Glob
  - Bash
enabled: true
---

# Code Reviewer Agent

You are a specialized code reviewer focused on:

1. **Code Quality**: Clean code principles, maintainability
2. **Security**: Common vulnerabilities (XSS, SQL injection, etc.)
3. **Performance**: Efficiency and optimization
4. **Best Practices**: Language-specific conventions

## Review Checklist

- [ ] Error handling and edge cases
- [ ] Code duplication
- [ ] Security vulnerabilities
- [ ] Performance bottlenecks
- [ ] Documentation and comments
- [ ] Test coverage

## Output Format

Provide feedback as:
- ✅ Good practices found
- ⚠️ Warnings (minor issues)
- ❌ Critical issues requiring immediate attention

Be constructive and suggest improvements.
```

### 2.2 TypeScript Interface

```typescript
interface SubAgentDefinition {
  // Metadata
  name: string;                    // Unique identifier (lowercase, no spaces)
  description: string;             // Purpose and when to use

  // Behavior
  model?: 'inherit' | 'sonnet' | 'opus' | 'haiku';
  tools?: string[];                // Tool whitelist (empty = all tools)
  enabled?: boolean;               // Can be disabled without deletion

  // Advanced
  maxIterations?: number;          // Override default iteration limit
  temperature?: number;            // Override model temperature
  systemPrompt: string;            // Main prompt (markdown body)

  // Metadata
  author?: string;
  version?: string;
  tags?: string[];
}
```

---

## 3. Core Classes

### 3.1 SubAgent Class

```typescript
export class SubAgent {
  private id: string;
  private definition: SubAgentDefinition;
  private workflow: AgentWorkflowV2;
  private messages: ChatMessage[] = [];
  private status: 'idle' | 'running' | 'completed' | 'failed';
  private result?: string;
  private error?: Error;

  constructor(definition: SubAgentDefinition, config: AgentConfig);

  async execute(task: string): Promise<SubAgentResult>;
  getStatus(): AgentStatus;
  getMessages(): ChatMessage[];
  abort(): void;
}

interface SubAgentResult {
  success: boolean;
  output: string;
  metadata: {
    tokensUsed: number;
    duration: number;
    toolCalls: number;
  };
  error?: string;
}
```

### 3.2 Orchestrator Class

```typescript
export class AgentOrchestrator {
  private mainAgent: AgentWorkflowV2;
  private registry: AgentRegistry;
  private activeSubAgents: Map<string, SubAgent>;

  constructor(config: AgentConfig);

  // Task delegation
  async delegateTask(
    agentName: string,
    task: string,
    options?: DelegationOptions
  ): Promise<SubAgentResult>;

  // Parallel execution
  async delegateParallel(
    tasks: Array<{ agent: string; task: string }>
  ): Promise<SubAgentResult[]>;

  // Agent management
  listAvailableAgents(): SubAgentDefinition[];
  createAgent(definition: SubAgentDefinition): void;
  removeAgent(name: string): void;

  // Monitoring
  getAgentStatus(id: string): AgentStatus;
  getAllActiveAgents(): AgentStatus[];
}
```

### 3.3 Agent Registry

```typescript
export class AgentRegistry {
  private agents: Map<string, SubAgentDefinition>;
  private searchPaths: string[];

  constructor();

  // Discovery
  loadAgents(): void;
  refreshAgents(): void;

  // Retrieval
  getAgent(name: string): SubAgentDefinition | null;
  getAllAgents(): SubAgentDefinition[];
  searchAgents(query: string): SubAgentDefinition[];

  // Persistence
  saveAgent(definition: SubAgentDefinition, scope: 'user' | 'project'): void;
  deleteAgent(name: string, scope: 'user' | 'project'): void;
}
```

---

## 4. Implementation Phases

### Phase 1: Foundation (Week 1)
**Goal**: Basic sub-agent infrastructure

- [ ] Create TypeScript interfaces and types
- [ ] Implement SubAgent class with isolated context
- [ ] Implement AgentRegistry for discovery
- [ ] Add agent storage in `.meer/agents/` and `~/.meer/agents/`
- [ ] Create 2-3 default agent templates

**Deliverables**:
- `src/agents/types.ts`
- `src/agents/subagent.ts`
- `src/agents/registry.ts`
- Default templates in `src/agents/templates/`

### Phase 2: Orchestration (Week 2)
**Goal**: Task delegation and coordination

- [ ] Implement AgentOrchestrator class
- [ ] Add task delegation (single agent)
- [ ] Add tool access control per agent
- [ ] Integrate with existing AgentWorkflowV2
- [ ] Add telemetry and logging

**Deliverables**:
- `src/agents/orchestrator.ts`
- Integration tests
- Delegation examples

### Phase 3: Parallel Execution (Week 3)
**Goal**: Multiple agents working simultaneously

- [ ] Implement parallel task delegation
- [ ] Add agent status monitoring
- [ ] Add result aggregation
- [ ] Handle agent failures gracefully
- [ ] Add progress reporting

**Deliverables**:
- Parallel execution API
- Status monitoring UI
- Error handling

### Phase 4: User Interface (Week 4)
**Goal**: User-friendly agent management

- [ ] Create `/agents` slash command
- [ ] Add agent creation wizard
- [ ] Add agent editing interface
- [ ] Add agent enable/disable toggle
- [ ] Create agent panel UI (Ink component)

**Deliverables**:
- `src/commands/agents.ts`
- `src/ui/agentPanel.tsx`
- Interactive CLI commands

### Phase 5: Advanced Features (Week 5)
**Goal**: Polish and advanced capabilities

- [ ] Add agent communication (sub-agent to sub-agent)
- [ ] Add agent chaining workflows
- [ ] Add automatic agent selection based on task
- [ ] Add agent performance metrics
- [ ] Create comprehensive documentation

**Deliverables**:
- Advanced orchestration features
- Performance dashboard
- Complete documentation

---

## 5. Task Delegation Patterns

### 5.1 Explicit Delegation (User-Initiated)

```bash
# User explicitly requests a sub-agent
> Use the code-reviewer agent to check my latest changes

# Orchestrator delegates to sub-agent
Orchestrator: Delegating to code-reviewer...
code-reviewer: Analyzing recent changes...
code-reviewer: Found 3 files changed...
code-reviewer: [Review output]
Orchestrator: Review complete. Summary: ...
```

### 5.2 Automatic Delegation (Proactive)

```bash
# User makes changes
> Refactor the authentication module

# Main agent completes refactoring
Main Agent: ✅ Refactored authentication module

# Orchestrator detects "code changes" and triggers reviewer
Orchestrator: Running code-reviewer (proactive)...
code-reviewer: Reviewing recent changes...
code-reviewer: ✅ Code quality looks good
code-reviewer: ⚠️ Consider adding error handling in login()
```

### 5.3 Parallel Delegation

```bash
# User requests multiple analyses
> Review the codebase for security and performance issues

# Orchestrator delegates to multiple agents in parallel
Orchestrator: Running 2 agents in parallel...
  [1/2] security-auditor: Scanning for vulnerabilities...
  [2/2] performance-analyzer: Analyzing bottlenecks...

security-auditor: ✅ No critical vulnerabilities found
performance-analyzer: ⚠️ Found 2 slow database queries

Orchestrator: Summary: [Aggregated results]
```

---

## 6. Communication Protocol

### 6.1 Orchestrator → Sub-Agent

```typescript
interface DelegationRequest {
  agentName: string;
  task: string;
  context?: {
    files?: string[];
    cwd?: string;
    metadata?: Record<string, any>;
  };
  options?: {
    timeout?: number;
    maxTokens?: number;
    priority?: number;
  };
}
```

### 6.2 Sub-Agent → Orchestrator

```typescript
interface SubAgentReport {
  agentId: string;
  agentName: string;
  task: string;
  status: 'success' | 'partial' | 'failed';
  output: string;
  summary: string;  // Condensed version for main context
  metadata: {
    tokensUsed: number;
    duration: number;
    toolsUsed: string[];
    errors?: string[];
  };
}
```

### 6.3 Context Compression

To avoid polluting the main conversation:
- Sub-agents return **summary** instead of full output
- Full output stored separately and available on demand
- Only key findings added to main context

---

## 7. Default Agent Templates

### 7.1 Code Reviewer
- **Tools**: Read, Grep, Glob, Bash
- **Focus**: Quality, security, best practices
- **Trigger**: After code changes

### 7.2 Debugger
- **Tools**: Read, Grep, Bash, git_log
- **Focus**: Root cause analysis, error investigation
- **Trigger**: Test failures, runtime errors

### 7.3 Test Writer
- **Tools**: Read, Write, propose_edit, run_command
- **Focus**: Generate unit tests, integration tests
- **Trigger**: New code without tests

### 7.4 Documentation Writer
- **Tools**: Read, Write, propose_edit
- **Focus**: README, API docs, inline comments
- **Trigger**: Undocumented code

### 7.5 Refactorer
- **Tools**: Read, Grep, propose_edit, find_references
- **Focus**: Code cleanup, DRY principles, patterns
- **Trigger**: Code smells detected

---

## 8. User Commands

### 8.1 `/agents` - Agent Management

```bash
# List all agents
/agents

# List active agents
/agents status

# Create new agent
/agents create

# Edit agent
/agents edit code-reviewer

# Enable/disable agent
/agents enable code-reviewer
/agents disable code-reviewer

# Delete agent
/agents delete custom-agent

# View agent details
/agents show code-reviewer
```

### 8.2 Delegation Commands

```bash
# Explicit delegation
@code-reviewer check the authentication module

# Or natural language
> Use the debugger agent to analyze this error

# Parallel execution
> Run both security-auditor and performance-analyzer on the API
```

---

## 9. Technical Considerations

### 9.1 Context Management

**Problem**: Sub-agents have isolated contexts
**Solution**:
- Main agent provides necessary context in delegation request
- Sub-agent can use tools to gather additional context
- Only summary returned to main conversation

### 9.2 Tool Access Control

**Problem**: Some agents shouldn't have all tools
**Solution**:
- Agent definitions specify tool whitelist
- Orchestrator filters available tools
- Attempts to use forbidden tools result in error

### 9.3 Cost Management

**Problem**: Multiple agents increase token usage and costs
**Solution**:
- Track per-agent token usage
- Set token limits per sub-agent
- User can configure agent budgets
- Provide cost breakdown in session tracker

### 9.4 Error Handling

**Problem**: Sub-agent failures shouldn't crash main agent
**Solution**:
- Wrap sub-agent execution in try-catch
- Report failures to orchestrator
- Orchestrator decides: retry, fail gracefully, or delegate to different agent

### 9.5 Concurrency

**Problem**: Parallel agents accessing same resources
**Solution**:
- Read-only tools are safe to parallelize
- Write operations (file edits) are serialized
- Use locking mechanism for shared resources

---

## 10. Integration with Existing Code

### 10.1 AgentWorkflowV2 Integration

```typescript
// Current: Single agent
const workflow = new AgentWorkflowV2(config);
await workflow.processMessage(userMessage);

// With orchestrator: Multi-agent
const orchestrator = new AgentOrchestrator(config);
await orchestrator.processMessage(userMessage);
// Orchestrator decides when to delegate to sub-agents
```

### 10.2 MCP Tools Integration

Sub-agents inherit MCP tool access:
```typescript
const subAgent = new SubAgent(definition, {
  ...config,
  mcpTools: mcpManager.listAllTools()
});
```

### 10.3 Session Tracking

```typescript
// Track sub-agent costs separately
sessionTracker.trackSubAgentTokens(agentName, {
  prompt: 1000,
  completion: 500
});

// Aggregate in session summary
const summary = sessionTracker.getSummary();
// {
//   mainAgent: { tokens: 5000, cost: 0.15 },
//   subAgents: {
//     'code-reviewer': { tokens: 2000, cost: 0.06 },
//     'test-writer': { tokens: 1500, cost: 0.045 }
//   }
// }
```

---

## 11. Testing Strategy

### 11.1 Unit Tests

- SubAgent class execution
- AgentRegistry discovery and loading
- AgentOrchestrator delegation logic
- Markdown parsing for agent definitions

### 11.2 Integration Tests

- End-to-end delegation flow
- Parallel agent execution
- Tool access control
- Error handling and recovery

### 11.3 Performance Tests

- Parallel vs serial execution time
- Context window usage
- Token consumption
- Memory usage with multiple agents

---

## 12. Documentation

### 12.1 User Documentation

- `docs/AGENTS_GUIDE.md` - User guide for creating and using agents
- `docs/AGENT_TEMPLATES.md` - Template examples and best practices
- In-CLI help via `/agents help`

### 12.2 Developer Documentation

- `docs/AGENTS_API.md` - API reference for developers
- `docs/AGENTS_ARCHITECTURE.md` - System architecture
- Inline code documentation

---

## 13. Success Metrics

### 13.1 Performance Metrics

- ✅ 3x faster for parallelizable tasks
- ✅ 50% reduction in main context pollution
- ✅ 90%+ task delegation accuracy

### 13.2 User Experience Metrics

- ✅ < 5 minutes to create a custom agent
- ✅ Natural language delegation works 95%+ of the time
- ✅ Agent recommendations are relevant 90%+ of the time

### 13.3 Code Quality Metrics

- ✅ 100% type safety
- ✅ 90%+ test coverage
- ✅ < 100ms orchestration overhead

---

## 14. Future Enhancements

### 14.1 Agent Marketplace
- Share agents with community
- Download popular agents
- Rate and review agents

### 14.2 Agent Learning
- Agents learn from user feedback
- Improve delegation accuracy over time
- Personalized agent recommendations

### 14.3 Visual Agent Builder
- Drag-and-drop agent creation
- Visual workflow editor
- Real-time agent testing

### 14.4 Agent Collaboration
- Sub-agents can request help from other sub-agents
- Multi-step workflows with agent handoffs
- Agent voting for best solution

---

## 15. Migration Plan

### 15.1 Backward Compatibility

- Existing workflows continue to work
- Gradual opt-in for sub-agents
- Feature flag for enabling/disabling system

### 15.2 Migration Steps

1. **Phase 1**: Deploy foundation with default agents
2. **Phase 2**: Enable for beta users
3. **Phase 3**: Gather feedback and iterate
4. **Phase 4**: General availability
5. **Phase 5**: Deprecate old single-agent approach (if desired)

---

## 16. Questions & Decisions

### 16.1 Open Questions

1. Should sub-agents have access to main conversation history?
2. How deep should agent nesting go? (sub-agents spawning sub-agents)
3. Should we support agent plugins/extensions?
4. What's the maximum number of parallel agents?

### 16.2 Design Decisions Made

✅ Agents defined in Markdown (not JSON) - more user-friendly
✅ Project-level agents override user-level - better customization
✅ Inherit model by default - cost-effective
✅ Tool whitelist per agent - security and control
✅ Automatic delegation based on keywords - proactive assistance

---

## 17. Timeline

| Week | Phase | Deliverable |
|------|-------|------------|
| 1 | Foundation | SubAgent, Registry, Templates |
| 2 | Orchestration | Orchestrator, Delegation |
| 3 | Parallel Execution | Multi-agent coordination |
| 4 | User Interface | CLI commands, Agent panel |
| 5 | Polish | Docs, Testing, Refinement |

**Total**: ~5 weeks for full implementation

---

## 18. Next Steps

To proceed with implementation:

1. ✅ Review and approve this plan
2. 🔲 Set up feature branch: `feature/sub-agents`
3. 🔲 Create TypeScript interfaces (`types.ts`)
4. 🔲 Implement SubAgent class (`subagent.ts`)
5. 🔲 Implement AgentRegistry (`registry.ts`)
6. 🔲 Create default agent templates
7. 🔲 Write unit tests
8. 🔲 Begin Phase 2 (Orchestration)

---

**Document Version**: 1.0
**Last Updated**: 2025-10-19
**Status**: 📋 Planning → 🚧 Ready for Implementation
