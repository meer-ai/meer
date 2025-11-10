# Workflow-v2 Analysis: Token Consumption & Professional Gaps

**Date:** 2025-11-10
**Analysis:** Comparison with Claude Code and GitHub Copilot patterns

---

## Executive Summary

The current workflow implementation is functional but consumes **3-5x more tokens** than professional implementations like Claude Code. Main issues:

1. **Massive system prompt** (~4000 tokens base cost)
2. **Unbounded message history** (exponential growth)
3. **Verbose tool results** (no truncation)
4. **No caching strategy** (repeated work)

**Estimated savings potential:** ~15,000 tokens/turn after optimizations
**Cost savings:** $15-30 per 100 turns

---

## 🔴 Critical Token Consumption Issues

### 1. Massive System Prompt (3000-5000 tokens base cost)

**Location:** `src/agent/prompts/systemPrompt.ts:12-1015`

Your system prompt is **~1000 lines** of text with extensive documentation. This is added to EVERY request.

**Problems:**
- Base prompt alone: ~3000-5000 tokens
- Includes exhaustive tool documentation (60+ tools described in detail)
- Many redundant examples and warnings
- Repeated instructions in different sections

**Claude Code approach:**
- Concise system prompt (~500-1000 tokens)
- Tool schemas sent separately, not in natural language
- Dynamic tool filtering (only relevant tools sent)

**Example redundancy:**
```markdown
Lines 24-58: "CRITICAL RULE" repeated multiple times
Lines 40-79: Same concept explained 3 different ways
Lines 81-113: Completion signals repeated throughout
Lines 133-842: Tool documentation could be 90% shorter
```

**Better approach:**
```typescript
// Instead of natural language:
"17. **git_status** - Show git working tree status (staged, unstaged, untracked files)
    `<tool name="git_status"></tool>`"

// Use JSON schema:
{
  name: "git_status",
  description: "Show git working tree status",
  parameters: {}
}
```

---

### 2. Unbounded Message History Growth

**Location:** `workflow-v2.ts:44, 241, 670-674`

```typescript
private messages: ChatMessage[] = [];  // Line 44

// Every iteration adds messages without pruning:
this.messages.push({ role: "user", content: userMessage });  // Line 241
this.messages.push({ role: "assistant", content: response }); // Line 670
this.messages.push({
  role: "user",
  content: `Tool Results:\n\n${toolResults.join("\n\n")}`  // Line 671-674
});
```

**Problems:**
- Messages accumulate indefinitely (10 iterations = 20+ messages)
- Each iteration roughly doubles context consumption
- No conversation summarization
- No pruning strategy

**Token growth pattern:**
```
Turn 1: 4,500 tokens
Turn 2: 10,850 tokens (2.4x)
Turn 3: 18,000 tokens (4x)
Turn 5: 35,000+ tokens (8x)
```

**Professional approach:**
- Keep only last N messages (sliding window)
- Summarize old context into compact form
- Prune redundant tool results
- Use conversation threading

---

### 3. Verbose Tool Result Format

**Location:** `workflow-v2.ts:533, 588, 646`

```typescript
return `Tool: ${toolCall.tool}\nResult: ${result}`;  // Line 533
toolResults.push(`Tool: ${toolCall.tool}\nResult: ${result}`);  // Line 588
content: `Tool Results:\n\n${toolResults.join("\n\n")}`  // Line 646
```

**Problems:**
- Full tool outputs sent verbatim (can be 1000s of lines)
- `read_file` returns entire file content (could be 10,000 lines)
- `list_files` can return huge directory trees
- No truncation or summarization

**Example scenario:**
```typescript
// User: "read the main app file"
// Result: 3000 lines of code = ~12,000 tokens
// This gets sent in EVERY subsequent request!
```

**Claude Code approach:**
- Truncates large outputs intelligently
- Uses file references instead of full content
- Summarizes repetitive data
- Shows only relevant portions

---

### 4. No Context Window Management

**Location:** `workflow-v2.ts:1626-1635`

```typescript
private warnIfContextHigh(tokens: number) {
  if (!this.contextLimit) return;
  const usage = tokens / this.contextLimit;
  if (usage > 0.9) {
    console.log(chalk.red(`\n⚠️ Context usage very high: ${(usage * 100).toFixed(0)}%`));
  }
}
```

**Problems:**
- Only warns, doesn't act
- No automatic pruning when approaching limit
- Will fail hard when limit is hit
- No graceful degradation strategy

**Better approach:**
- Auto-prune when 70% full
- Summarize old messages
- Drop least important tool results
- Fallback to smaller model if needed

---

## 🟡 Professionalism Gaps

### 1. Overly Verbose System Prompt

**Issue:** System prompt contains walls of examples, warnings, and documentation that could be 90% shorter.

**Specific examples:**
- **Lines 24-58:** "CRITICAL RULE" and "ABSOLUTELY FORBIDDEN" repeated 5+ times
- **Lines 40-79:** Same execution pattern explained in 3 different ways
- **Lines 81-113:** Completion signals listed multiple times
- **Lines 133-842:** 60+ tools with verbose natural language docs
- **Lines 898-1014:** Example section with 10+ examples (could be 3-4)

**Impact:**
- ~3000-4000 wasted tokens per request
- Harder for LLM to find relevant instructions
- Slower processing time
- Higher latency

**Recommendation:**
```markdown
# Concise version (target: 800 tokens)

You are Meer AI, a coding assistant with tool access.

## Execution Rules
1. Execute tools ONE AT A TIME
2. Never show code before tool execution
3. Stop after asking questions
4. React to each tool result before continuing

## Available Tools
[JSON schemas - 200 tokens]

## Examples
[2-3 key examples only - 300 tokens]
```

---

### 2. No Intelligent Tool Result Processing

**Location:** `workflow-v2.ts:867-868, 871-872`

```typescript
case "read_file":
  const readResult = tools.readFile(params.path, this.cwd);
  return readResult.error ? readResult.error : readResult.result;
```

**Problems:**
- Returns full file content regardless of size (could be 10,000 lines)
- No truncation for large files
- No "already read" detection
- No content hashing to avoid re-sending
- No smart excerpting (e.g., "show only function X")

**Better approach:**
```typescript
case "read_file":
  const content = tools.readFile(params.path, this.cwd);

  // Check if already in context
  if (this.isFileInContext(params.path)) {
    return `File ${params.path} already in context`;
  }

  // Truncate if too large
  if (content.length > 5000) {
    return `[File too large - ${content.length} chars. First 5000 chars shown]\n${content.slice(0, 5000)}`;
  }

  this.trackFileInContext(params.path);
  return content;
```

---

### 3. Missing Conversation Summarization

**Gap:** No strategy to compact conversation history as it grows.

**What Claude Code likely does:**
```typescript
private async summarizeOldContext(): Promise<void> {
  if (this.messages.length <= 10) return;

  // Take messages 2-6 (skip system, keep recent)
  const oldMessages = this.messages.slice(1, -6);

  // Create compact summary
  const summary = this.createSummary(oldMessages);

  // Replace old messages with summary
  this.messages = [
    this.messages[0], // system prompt
    { role: "system", content: `Previous context: ${summary}` },
    ...this.messages.slice(-6) // Keep last 6 messages
  ];
}

private createSummary(messages: ChatMessage[]): string {
  // Extract key facts: files read, edits made, user goals
  const filesRead = this.extractFilesRead(messages);
  const editsMade = this.extractEdits(messages);
  const userGoal = this.extractUserGoal(messages);

  return `Goal: ${userGoal}\nFiles accessed: ${filesRead.join(', ')}\nEdits: ${editsMade.length} files modified`;
}
```

**Benefits:**
- Keeps context bounded
- Preserves important information
- Reduces token usage by 50-70% after turn 5

---

### 4. No Tool Call Deduplication

**Gap:** Repeated tool calls with same parameters waste tokens.

**Example scenario:**
```typescript
// Turn 1: User says "check the config"
read_file("config.yaml") → 500 lines

// Turn 3: LLM says "Let me check the config again"
read_file("config.yaml") → Same 500 lines (wasted!)

// Turn 5: User says "what was in the config?"
read_file("config.yaml") → Same 500 lines (wasted again!)
```

**Better approach:**
```typescript
private toolCache = new Map<string, {
  result: string,
  timestamp: number,
  hits: number
}>();

private async executeToolWithCache(toolCall: any): Promise<string> {
  const key = `${toolCall.tool}:${JSON.stringify(toolCall.params)}`;
  const cached = this.toolCache.get(key);

  // Return cached result if recent (2 min window)
  if (cached && Date.now() - cached.timestamp < 120000) {
    cached.hits++;
    logVerbose(`Cache hit for ${toolCall.tool} (${cached.hits} hits)`);
    return `[Cached result from ${Math.round((Date.now() - cached.timestamp) / 1000)}s ago]\n${cached.result}`;
  }

  // Execute and cache
  const result = await this.executeTool(toolCall);
  this.toolCache.set(key, { result, timestamp: Date.now(), hits: 0 });
  return result;
}
```

**Benefits:**
- Saves ~1000-3000 tokens per duplicate call
- Faster execution (no re-computation)
- Clear signal to LLM that data is cached

---

### 5. Inefficient Context Preprocessing

**Location:** `workflow-v2.ts:209-238`

```typescript
if (options?.enableAutoContext) {
  const relevantFiles = await this.contextPreprocessor.gatherContext(userMessage);
  if (relevantFiles.length > 0) {
    const contextPrompt = this.contextPreprocessor.buildContextPrompt(relevantFiles);
    this.messages.push({ role: 'system', content: contextPrompt });
  }
}
```

**Problems:**
- Adds full file contents to messages before LLM even responds
- No deduplication with files already in context
- Grows context significantly on every turn
- LLM might not even need these files

**Better approach:**
```typescript
// Only add file REFERENCES, not full content
const relevantFiles = await this.contextPreprocessor.gatherContext(userMessage);
const fileRefs = relevantFiles.map(f => ({
  path: f.path,
  reason: f.reason,
  size: f.content.length
}));

// Store files in a side registry
this.contextRegistry.addFiles(relevantFiles);

// Add lightweight reference in prompt
this.messages.push({
  role: 'system',
  content: `Relevant files available: ${fileRefs.map(f => f.path).join(', ')}\nUse read_file to access if needed.`
});
```

**Benefits:**
- Saves ~3000-5000 tokens per turn
- LLM only loads files it actually needs
- More control over context usage

---

## 📊 Token Consumption Comparison

### Current Workflow (Estimated)

```
Turn 1:
├─ System prompt: 4000 tokens
├─ User message: 50 tokens
├─ MCP tools listing: 500 tokens
└─ Total prompt: ~4,550 tokens

Turn 2 (after reading 3 files):
├─ System prompt: 4000 tokens
├─ User message: 50 tokens
├─ MCP tools: 500 tokens
├─ Assistant response: 300 tokens
├─ Tool results (3 files): 6000 tokens
└─ Total prompt: ~10,850 tokens (2.4x growth!)

Turn 3:
├─ All previous messages
├─ New tool results: 4000 tokens
└─ Total prompt: ~18,000 tokens (4x growth!)

Turn 5:
└─ Total prompt: ~35,000+ tokens (8x growth!)
```

### Claude Code Pattern (Estimated)

```
Turn 1:
├─ Concise system prompt: 800 tokens
├─ Tool schemas: 200 tokens (JSON format)
├─ User message: 50 tokens
└─ Total: ~1,050 tokens

Turn 2:
├─ System prompt: 800 tokens
├─ Tool schemas: 200 tokens
├─ Last 2 messages: 400 tokens
├─ Summarized results: 1000 tokens
└─ Total: ~2,400 tokens (vs your 10,850!)

Turn 3:
├─ Prunes old messages
├─ Keeps only recent context
└─ Total: ~3,500 tokens (vs your 18,000!)

Turn 5:
├─ Auto-summarization kicks in
└─ Total: ~5,000 tokens (vs your 35,000+!)
```

**Comparison:**
| Turn | Your Workflow | Claude Code | Ratio |
|------|---------------|-------------|-------|
| 1    | 4,550         | 1,050       | 4.3x  |
| 2    | 10,850        | 2,400       | 4.5x  |
| 3    | 18,000        | 3,500       | 5.1x  |
| 5    | 35,000+       | 5,000       | 7.0x  |

---

## ✅ Recommendations (Priority Order)

### 1. HIGH PRIORITY: Compress System Prompt

**Goal:** Reduce from ~4000 tokens to ~1000 tokens

**Action items:**
1. Move tool documentation to JSON schemas
2. Remove redundant examples (keep 2-3 best ones)
3. Consolidate repeated warnings into single section
4. Use bullet points instead of paragraphs
5. Remove verbose examples section

**Implementation:**
```typescript
// Create separate file: toolSchemas.ts
export const TOOL_SCHEMAS = [
  {
    name: "read_file",
    description: "Read file contents",
    parameters: {
      path: { type: "string", required: true }
    }
  },
  // ... rest of tools
];

// In systemPrompt.ts - reference schemas instead of documenting
const toolDocs = TOOL_SCHEMAS.map(t =>
  `- ${t.name}: ${t.description}`
).join('\n');
```

**Estimated savings:** ~3000 tokens per request
**ROI:** Highest - affects every single request

---

### 2. HIGH PRIORITY: Implement Message Sliding Window

**Goal:** Keep message history bounded to ~12 messages max

**Implementation:**
```typescript
// Add to workflow-v2.ts
private pruneMessages(): void {
  const MAX_MESSAGES = 12; // System + 5 conversation turns
  const KEEP_RECENT = 6;   // Always keep last 3 turns

  if (this.messages.length <= MAX_MESSAGES) return;

  logVerbose(chalk.yellow(`Pruning messages: ${this.messages.length} → ${MAX_MESSAGES}`));

  // Keep system prompt + recent messages
  const systemMessages = this.messages.filter(m => m.role === 'system');
  const recentMessages = this.messages.slice(-KEEP_RECENT);

  this.messages = [...systemMessages, ...recentMessages];
}

// Call before each LLM request (around line 270)
async processMessage(userMessage: string, options?: {...}) {
  // ... existing code ...

  // Prune before making API call
  this.pruneMessages();

  const promptTokens = countMessageTokens(this.model, this.messages);
  // ... rest of the code
}
```

**Estimated savings:** ~5,000-10,000 tokens per request after Turn 3
**ROI:** Very high - exponential savings as conversation grows

---

### 3. MEDIUM PRIORITY: Truncate Large Tool Results

**Goal:** Limit tool results to reasonable size

**Implementation:**
```typescript
// Add to workflow-v2.ts
private formatToolResult(toolName: string, result: string): string {
  const MAX_LENGTH = 3000; // characters (~750 tokens)
  const MAX_LINES = 100;

  const lines = result.split('\n');

  // For read operations, truncate intelligently
  if (toolName === 'read_file' || toolName === 'list_files') {
    if (result.length > MAX_LENGTH || lines.length > MAX_LINES) {
      const truncated = lines.slice(0, MAX_LINES).join('\n').slice(0, MAX_LENGTH);
      const omitted = Math.max(lines.length - MAX_LINES, 0);

      return `Tool: ${toolName}\nResult (truncated - ${result.length} chars, ${lines.length} lines):\n${truncated}\n\n[... ${omitted} more lines omitted. Use grep or read specific sections if needed]`;
    }
  }

  return `Tool: ${toolName}\nResult:\n${result}`;
}

// Update in executeTool method (line 533, 588)
try {
  const result = await this.executeTool(toolCall);
  // ... success handling
  return this.formatToolResult(toolCall.tool, result);
} catch (error) {
  // ... error handling
}
```

**Estimated savings:** ~2,000-5,000 tokens for large file reads
**ROI:** Medium-high - common in coding workflows

---

### 4. MEDIUM PRIORITY: Add Tool Call Caching

**Goal:** Avoid re-executing identical tool calls

**Implementation:**
```typescript
// Add to workflow-v2.ts class properties
private toolCache = new Map<string, {
  result: string;
  timestamp: number;
  hits: number;
}>();

private getCachedResult(tool: string, params: any): string | null {
  const key = `${tool}:${JSON.stringify(params)}`;
  const cached = this.toolCache.get(key);

  const CACHE_TTL = 120000; // 2 minutes

  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    cached.hits++;
    const age = Math.round((Date.now() - cached.timestamp) / 1000);
    logVerbose(chalk.blue(`Cache hit for ${tool} (${cached.hits} hits, ${age}s old)`));
    return `[Cached from ${age}s ago]\n${cached.result}`;
  }

  return null;
}

private cacheResult(tool: string, params: any, result: string): void {
  const key = `${tool}:${JSON.stringify(params)}`;
  this.toolCache.set(key, {
    result,
    timestamp: Date.now(),
    hits: 0
  });

  // Clean old cache entries (keep last 50)
  if (this.toolCache.size > 50) {
    const oldestKey = Array.from(this.toolCache.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp)[0][0];
    this.toolCache.delete(oldestKey);
  }
}

// Modify executeTool (line 855)
private async executeTool(toolCall: any): Promise<string> {
  const { tool, params } = toolCall;

  // Check cache for read-only operations
  const READ_ONLY_TOOLS = new Set([
    'read_file', 'list_files', 'find_files', 'grep', 'search_text',
    'git_status', 'git_log', 'analyze_project'
  ]);

  if (READ_ONLY_TOOLS.has(tool)) {
    const cached = this.getCachedResult(tool, params);
    if (cached) return cached;
  }

  // Execute tool
  const result = await this.executeToolInternal(toolCall);

  // Cache read-only results
  if (READ_ONLY_TOOLS.has(tool)) {
    this.cacheResult(tool, params, result);
  }

  return result;
}

// Rename existing executeTool to executeToolInternal
private async executeToolInternal(toolCall: any): Promise<string> {
  // ... existing executeTool implementation ...
}
```

**Estimated savings:** ~1,000-3,000 tokens for repeated queries
**ROI:** Medium - depends on usage patterns

---

### 5. LOW PRIORITY: Use Tool References Instead of Full Content

**Goal:** Send file references instead of full content after first read

**Implementation:**
```typescript
// Add to workflow-v2.ts
private fileRegistry = new Map<string, {
  hash: string;
  content: string;
  lastAccess: number;
}>();

private registerFile(path: string, content: string): string {
  const hash = this.hashContent(content);
  this.fileRegistry.set(path, {
    hash,
    content,
    lastAccess: Date.now()
  });
  return hash;
}

private hashContent(content: string): string {
  // Simple hash function
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) - hash) + content.charCodeAt(i);
    hash = hash & hash;
  }
  return hash.toString(16);
}

private isFileInContext(path: string): boolean {
  return this.fileRegistry.has(path);
}

// Update read_file tool (around line 867)
case "read_file":
  const readResult = tools.readFile(params.path, this.cwd);
  if (readResult.error) return readResult.error;

  // Check if already in context
  if (this.isFileInContext(params.path)) {
    const entry = this.fileRegistry.get(params.path)!;
    const newHash = this.hashContent(readResult.result);

    if (entry.hash === newHash) {
      entry.lastAccess = Date.now();
      return `File ${params.path} already in context (unchanged since last read)`;
    } else {
      // File changed, update registry
      this.registerFile(params.path, readResult.result);
      return `File ${params.path} updated:\n${readResult.result}`;
    }
  }

  // First time reading
  this.registerFile(params.path, readResult.result);
  return readResult.result;
```

**Advanced version - Send references:**
```typescript
// In system prompt, add:
"Files shown as <file-ref> have been provided earlier in the conversation.
You have access to their full content. No need to re-read unless checking for changes."

// Tool result format:
return `<file-ref hash="${hash}" path="${params.path}" lines="${lines.length}" />`;
```

**Estimated savings:** ~2,000-5,000 tokens in longer sessions
**ROI:** Low-medium - more complex, needs careful testing

---

## 📈 Expected Impact

Implementing these changes in priority order:

| Improvement | Token Savings/Turn | Cost Savings* | Complexity |
|-------------|-------------------|---------------|------------|
| 1. System prompt compression | ~3,000 | $3-6 | Low |
| 2. Message pruning | ~7,000 (turn 4+) | $7-14 | Low |
| 3. Result truncation | ~3,000 | $3-6 | Low |
| 4. Tool caching | ~2,000 | $2-4 | Medium |
| 5. File references | ~2,000 | $2-4 | High |
| **Total** | **~15,000** | **$15-30** | - |

*Cost savings per 100 turns, assuming $0.01/1K tokens

### Cumulative Impact Example

**10-turn conversation:**

| Scenario | Total Tokens | Cost ($) | Savings |
|----------|-------------|----------|---------|
| Current implementation | ~200,000 | $2.00 | - |
| After improvements 1-2 | ~80,000 | $0.80 | 60% |
| After all improvements | ~60,000 | $0.60 | 70% |

---

## 🎯 Additional Professional Improvements

### A. Better Error Recovery

**Current:** Basic retry with timeout detection (lines 411-434)

**Professional approach:**
```typescript
private async executeWithRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    backoff?: 'linear' | 'exponential';
    onRetry?: (attempt: number, error: Error) => void;
  } = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const backoff = options.backoff ?? 'exponential';

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries) throw error;

      const delay = backoff === 'exponential'
        ? Math.pow(2, attempt) * 1000
        : attempt * 1000;

      options.onRetry?.(attempt, error as Error);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw new Error('Max retries exceeded');
}
```

---

### B. Streaming Optimization

**Current:** Streams output but doesn't optimize for partial results

**Better approach:**
```typescript
// Send partial tool results as they come
private async executeToolWithStreaming(toolCall: any): Promise<string> {
  if (toolCall.tool === 'run_command') {
    // Stream command output as it arrives
    const process = spawn(toolCall.params.command);
    let output = '';

    process.stdout.on('data', (chunk) => {
      output += chunk;
      // Could send incremental updates to LLM
      this.onToolProgress?.(toolCall.tool, chunk);
    });

    await new Promise(resolve => process.on('close', resolve));
    return output;
  }

  return this.executeToolInternal(toolCall);
}
```

---

### C. Multi-turn Planning

**Current:** Reactive, no explicit planning state

**Better approach:**
```typescript
interface ExecutionPlan {
  goal: string;
  steps: Array<{
    description: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    tools?: string[];
  }>;
  currentStep: number;
}

class PlanningWorkflow extends AgentWorkflowV2 {
  private plan?: ExecutionPlan;

  async processMessage(userMessage: string, options?: any) {
    // Detect if this is a complex multi-step task
    if (this.isComplexTask(userMessage)) {
      this.plan = await this.createPlan(userMessage);
    }

    // Execute within plan context
    return super.processMessage(userMessage, {
      ...options,
      context: this.plan
    });
  }
}
```

---

### D. Better Test Integration

**Current:** Test auto-run is bolt-on (lines 1786-1881)

**Better approach:**
```typescript
// Integrate testing into the workflow lifecycle
class TestAwareWorkflow extends AgentWorkflowV2 {
  async processMessage(userMessage: string, options?: any) {
    const result = await super.processMessage(userMessage, options);

    // After significant edits, automatically validate
    if (this.editedFiles.size > 0 && this.shouldRunTests()) {
      await this.runValidation({
        tests: true,
        typeCheck: true,
        lint: false
      });
    }

    return result;
  }

  private shouldRunTests(): boolean {
    // Smart heuristics: run tests if editing core logic
    return Array.from(this.editedFiles).some(file =>
      !file.includes('test') &&
      !file.includes('config') &&
      !file.includes('.md')
    );
  }
}
```

---

### E. Metrics & Observability

**Current:** Basic token counting

**Professional approach:**
```typescript
interface WorkflowMetrics {
  tokenUsage: {
    byTurn: number[];
    byTool: Map<string, number>;
    systemPrompt: number;
    conversation: number;
    toolResults: number;
  };
  performance: {
    toolExecutionTime: Map<string, number[]>;
    llmLatency: number[];
    cacheHitRate: number;
  };
  usage: {
    toolCalls: Map<string, number>;
    errorRate: number;
    retries: number;
  };
}

class ObservableWorkflow extends AgentWorkflowV2 {
  private metrics: WorkflowMetrics = {
    // ... initialize
  };

  async processMessage(userMessage: string, options?: any) {
    const startTime = Date.now();

    try {
      const result = await super.processMessage(userMessage, options);
      this.recordSuccess(Date.now() - startTime);
      return result;
    } catch (error) {
      this.recordError(error);
      throw error;
    }
  }

  getMetricsSummary(): string {
    return `
Token usage:
  - Average per turn: ${this.metrics.tokenUsage.byTurn.reduce((a,b) => a+b, 0) / this.metrics.tokenUsage.byTurn.length}
  - System prompt overhead: ${this.metrics.tokenUsage.systemPrompt}
  - Cache hit rate: ${this.metrics.performance.cacheHitRate}%

Top tools:
${Array.from(this.metrics.usage.toolCalls.entries())
  .sort((a, b) => b[1] - a[1])
  .slice(0, 5)
  .map(([tool, count]) => `  - ${tool}: ${count} calls`)
  .join('\n')}
    `;
  }
}
```

---

## 🚀 Implementation Roadmap

### Phase 1: Quick Wins (1-2 days)
- [ ] Compress system prompt (save ~3000 tokens/turn)
- [ ] Implement message sliding window (save ~7000 tokens/turn)
- [ ] Add basic result truncation (save ~3000 tokens/turn)

**Expected impact:** 60-70% token reduction

### Phase 2: Optimizations (3-5 days)
- [ ] Add tool call caching
- [ ] Implement better error handling
- [ ] Add metrics tracking

**Expected impact:** Additional 10-15% reduction

### Phase 3: Advanced (1-2 weeks)
- [ ] File reference system
- [ ] Conversation summarization
- [ ] Multi-turn planning
- [ ] Streaming optimizations

**Expected impact:** Another 5-10% reduction + better UX

---

## 📝 Testing Strategy

### Before Implementing Changes:

1. **Baseline metrics:**
   ```bash
   # Create test suite that measures:
   - Token usage per turn
   - Response quality (subjective)
   - Tool call frequency
   - Cache hit rates (after caching implemented)
   ```

2. **Test scenarios:**
   - Simple query (1-2 turns)
   - Medium complexity (5-7 turns)
   - Complex multi-file edit (10+ turns)
   - Debugging session (15+ turns)

3. **Quality checks:**
   - Ensure truncation doesn't lose critical info
   - Verify message pruning preserves context
   - Test that caching doesn't serve stale data

### After Each Phase:

1. Run full test suite
2. Compare metrics vs baseline
3. Manual testing for edge cases
4. User acceptance testing

---

## 🎓 Key Takeaways

### What Makes Claude Code Efficient:

1. **Concise prompts** - Every token counts
2. **Bounded context** - Sliding window + summarization
3. **Smart caching** - Avoid redundant work
4. **Progressive disclosure** - Only load what's needed
5. **Structured data** - JSON schemas over prose

### What Your Workflow Does Well:

1. ✅ Good tool categorization (parallel vs sequential)
2. ✅ Transaction management for safety
3. ✅ Test awareness and auto-run
4. ✅ Context preprocessing capability
5. ✅ Comprehensive tool set

### Biggest Opportunities:

1. 🎯 **System prompt** - Easiest, highest impact
2. 🎯 **Message history** - Critical for long sessions
3. 🎯 **Result formatting** - Low hanging fruit
4. 📊 **Caching** - Medium effort, good ROI
5. 🔮 **File references** - Advanced, nice-to-have

---

## 📚 References

**Similar projects to study:**
- Claude Code (closed source, but patterns observable)
- GitHub Copilot Chat (closed source)
- Continue.dev (open source alternative)
- Cursor (closed source, but has published some patterns)

**Best practices:**
- Keep system prompts under 1000 tokens
- Prune conversation history after 10-15 messages
- Cache read-only operations for 2-5 minutes
- Truncate large outputs to 3000-5000 chars
- Use JSON schemas for tool definitions

**Token estimation:**
- ~4 characters = 1 token (English)
- ~1 line of code = 5-10 tokens
- ~1 page of text = 300-500 tokens

---

## 🏁 Conclusion

Your workflow is **functional and feature-rich**, but uses **3-5x more tokens** than necessary. The good news: most optimizations are straightforward refactoring, not architectural changes.

**Priority actions:**
1. ✅ Compress system prompt (1 day, huge impact)
2. ✅ Add message pruning (1 day, huge impact)
3. ✅ Truncate tool results (1 day, good impact)

These three changes alone will reduce token consumption by **60-70%** and cost by similar amount.

The remaining optimizations (caching, file references, etc.) are nice-to-haves that can be added incrementally.

**Estimated effort:** 3-5 days for core improvements
**Estimated savings:** $15-30 per 100 turns
**Break-even:** Very quick for active users
