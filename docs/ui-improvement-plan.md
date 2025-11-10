# UI/UX Improvement Plan for Meer CLI

**Date:** 2025-11-11
**Focus:** Terminal User Interface (TUI) enhancements to match Claude Code & GitHub Copilot CLI

---

## Executive Summary

Meer CLI has **two parallel UI implementations**: a legacy readline/inquirer-based UI and a modern Ink/React-based UI. While the Ink foundation exists, it's underutilized. Professional CLI tools like Claude Code and GitHub Copilot CLI provide superior UX through:

1. **Visual hierarchy** - Clear separation of concerns
2. **Progressive disclosure** - Show what's needed, hide what's not
3. **Real-time feedback** - Streaming updates with context
4. **Interactive elements** - Rich components for complex workflows
5. **Spatial organization** - Multi-panel layouts

**Current state:** Basic text output with minimal visual structure
**Goal:** Modern TUI with professional polish matching industry leaders

---

## Current UI Architecture

### 1. Dual UI System

```
┌─ Legacy UI (Primary) ─────────────────────────┐
│ • ChatBoxUI (chatbox.ts)                      │
│ • readline + inquirer                         │
│ • Text-based prompts                          │
│ • Basic ora spinners                          │
│ • Minimal visual structure                    │
└───────────────────────────────────────────────┘

┌─ Modern UI (Underutilized) ───────────────────┐
│ • MeerChat.tsx (Ink/React)                    │
│ • InkChatAdapter                              │
│ • Rich components available                   │
│ • NOT fully integrated                        │
└───────────────────────────────────────────────┘

┌─ Shared Components ───────────────────────────┐
│ • WorkflowTimeline (ora-based)                │
│ • LineEditor (custom readline wrapper)        │
│ • response-formatter (markdown rendering)     │
└───────────────────────────────────────────────┘
```

### 2. Current UI Files Analysis

| File | Purpose | Tech | Issues |
|------|---------|------|--------|
| `chatbox.ts` (1374 lines) | Main input loop | readline/inquirer | Complex, hard to maintain |
| `MeerChat.tsx` (644 lines) | Modern UI | Ink/React | Good foundation, underused |
| `InkChatAdapter.ts` (384 lines) | Bridge layer | Adapter pattern | Exists but not default |
| `workflowTimeline.ts` (199 lines) | Task tracking | ora spinners | Basic, not visual enough |
| `lineEditor.ts` (274 lines) | Input handling | Custom | Over-engineered for simple task |
| `response-formatter.ts` | Markdown render | marked-terminal | Works but basic |

**Problem:** Dual system means maintaining two codebases. Ink UI exists but isn't the default experience.

---

## Gap Analysis: vs Claude Code & GitHub Copilot CLI

### 1. Tool Execution Visualization ❌ MAJOR GAP

**Industry Standard (Claude Code):**
```
┌─ Tools Executing ──────────────────────────────────────────┐
│ ✓ read_file(src/app.tsx)                        250ms      │
│ ⏳ analyze_project                               ...        │
│ ⏸ git_status                                    [queued]   │
└────────────────────────────────────────────────────────────┘
```

**Your Current Implementation:**
```
🔧 Executing 3 tool(s)...
  → read_file
  ✓ Done
  → analyze_project
  ✓ Done
```

**Gaps:**
- No visual grouping of tool calls
- No timing information displayed
- No progress bars for long operations
- No parallel vs sequential indicators
- Tool results mixed with conversation
- No collapsible/expandable sections

**Impact:** Users can't see what's happening or how long it takes.

---

### 2. Main Screen Layout ❌ MAJOR GAP

**Industry Standard:**
```
┌────────────────────────────────────────────────────────────┐
│ 🌊 Meer AI  │  gpt-4  │  ~/project  │  💰 $0.03  │  📊 2.3K │
├────────────────────────────────────────────────────────────┤
│                                                            │
│ 👤 You: How does authentication work?                     │
│                                                            │
│ 🤖 Meer:                                                   │
│ I'll analyze the auth flow.                               │
│                                                            │
│ ┌─ Tools (2) ─────────────────────────────────┐          │
│ │ ✓ read_file(src/auth.ts)            142ms   │          │
│ │ ✓ grep("login", "src/**/*.ts")      89ms    │          │
│ │ Total: 231ms                                 │          │
│ └──────────────────────────────────────────────┘          │
│                                                            │
│ Based on the code, here's how it works...                 │
│ <rest of response>                                         │
│                                                            │
├────────────────────────────────────────────────────────────┤
│ > Type a message...                           [Edit Mode] │
│ Enter to send • Esc to interrupt • Ctrl+P for plan mode   │
└────────────────────────────────────────────────────────────┘
```

**Your Current Implementation:**
```
─────────────────────────────────
~/project | ready | gpt-4:openai

> How does authentication work?

🤖 MeerAI:

I'll analyze the auth flow.

🔧 Executing 2 tool(s)...
  → read_file
  ✓ Done
  → grep
  ✓ Done

Based on the code, here's how it works...

🪙 Tokens: 50 in + 120 out (this turn)

> _
```

**Gaps:**
- No persistent header with status
- No visual separation between sections
- Tool results inline with text (cluttered)
- Token info only at end, not real-time
- No cost tracking visible
- No mode indicator (edit vs plan)
- No session stats visible

---

### 3. Streaming Response UI ❌ MODERATE GAP

**Industry Standard:**
```
🤖 Generating response...

Let me check the config |  [Streaming: 2.3s elapsed]

┌─ Code Preview ─────────────────────────────────┐
│ const config = {                               │
│   ▊                        [syntax highlight] │
│                                                │
└────────────────────────────────────────────────┘

Tokens: 245 → 512  [+267]  Cost: $0.0023
```

**Your Current:**
```
🤖 MeerAI:

Let me check the config

const config = {

[waits for complete response before showing tokens]
```

**Gaps:**
- No streaming progress indicator
- No real-time token counter
- No syntax highlighting during stream
- No partial code block rendering
- No elapsed time shown
- No cost accumulation visible

---

### 4. File/Code Diffs ❌ MODERATE GAP

**Industry Standard (Cursor/Claude Code):**
```
┌─ Changes to src/app.tsx ───────────────────────────────────┐
│ @@ -12,3 +12,5 @@                                          │
│                                                            │
│  export function App() {                                   │
│ -  return <div>Hello</div>;                [line 12]      │
│ +  return (                                 [line 12-15]   │
│ +    <div className="app">Hello</div>                      │
│ +  );                                                       │
│  }                                                          │
│                                                            │
│ [a]ccept  [r]eject  [e]dit  [n]ext  [q]uit               │
└────────────────────────────────────────────────────────────┘
```

**Your Current:**
```
📝 src/app.tsx
   Edit file

┌─ Changes:
-  return <div>Hello</div>;
+  return (
+    <div className="app">Hello</div>
+  );
└─

Apply changes to src/app.tsx?
✅ Apply changes
⏭️  Skip this file
❌ Cancel all edits
```

**Gaps:**
- No inline diff view
- No line numbers
- No navigation between hunks
- No partial acceptance
- No side-by-side option
- No syntax highlighting in diffs

---

### 5. Agent Workflow Visualization ❌ MAJOR GAP

**Industry Standard:**
```
┌─ Workflow Progress ─────────────────────────────────┐
│ ┌──────────────────────────────────────────┐       │
│ │ █████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 35% │       │
│ └──────────────────────────────────────────┘       │
│                                                     │
│ ✓ Analyze request                          120ms   │
│ ✓ Read files (3)                           340ms   │
│ ⏳ Generate code                            ...     │
│ ⏸ Run tests                                [wait]  │
│ ⏸ Apply changes                            [wait]  │
│                                                     │
│ Iteration 2 of 10                                  │
└─────────────────────────────────────────────────────┘
```

**Your Current:**
```
🔄 Iteration 2/10

🔧 Executing 1 tool(s)...
  → propose_edit
  ✓ Done

[shows full conversation history]
```

**Gaps:**
- No progress bar
- No task breakdown visible
- No ETAs or time estimates
- No workflow stages shown
- Iterations shown inline, not summary
- No "big picture" view of what's happening

---

### 6. Interactive File Picker ❌ MODERATE GAP

**Industry Standard:**
```
┌─ Select files (@mention) ──────────────────────────────────┐
│ Search: auth                                     3 results │
├────────────────────────────────────────────────────────────┤
│ > src/auth/login.ts                    [modified 2h ago]  │
│   src/auth/register.ts                 [modified 5d ago]  │
│   src/auth/middleware.ts               [modified 1w ago]  │
├────────────────────────────────────────────────────────────┤
│ ↑↓ navigate • Enter select • Type to filter • Esc cancel  │
└────────────────────────────────────────────────────────────┘
```

**Your Current (inquirer list):**
```
? Select file for @auth (filtered: "auth")
❯ src/auth/login.ts
  src/auth/register.ts
  src/auth/middleware.ts
  Refine search
  Keep @auth as typed
  Cancel message
```

**Gaps:**
- No visual context (file size, mod time)
- No preview pane
- No multi-select
- Basic list, not rich UI
- No fuzzy search visualization
- No recency indicators

---

### 7. Error Handling & Debugging ❌ MODERATE GAP

**Industry Standard:**
```
┌─ Error ──────────────────────────────────────────────────┐
│ ❌ Tool execution failed: read_file                      │
│                                                          │
│ Error: ENOENT: no such file or directory                │
│ File: src/missing.ts                                     │
│                                                          │
│ ┌─ Context ─────────────────────────────────┐           │
│ │ Called from: workflow.ts:234              │           │
│ │ Tool params: { path: "src/missing.ts" }   │           │
│ │ Attempt: 1 of 3                           │           │
│ └───────────────────────────────────────────┘           │
│                                                          │
│ [r]etry  [s]kip  [a]bort  [d]ebug                       │
└──────────────────────────────────────────────────────────┘
```

**Your Current:**
```
❌ Error: ENOENT: no such file or directory

[continues with next iteration]
```

**Gaps:**
- No structured error display
- No context shown
- No retry options
- No stack traces accessible
- Errors scroll away quickly
- No error history

---

### 8. Token & Cost Tracking ❌ MODERATE GAP

**Industry Standard:**
```
┌─ Session Stats ─────────────────────────────────────────┐
│ Tokens: 12,450 / 128,000 (9.7%) [████░░░░░░░░░░░░░░░░░] │
│ Cost: $0.34 / $5.00 budget   [███░░░░░░░░░░░░░░░░░░░░░] │
│ Messages: 23  │  Tools: 45  │  Uptime: 12m 34s         │
└─────────────────────────────────────────────────────────┘
```

**Your Current:**
```
[end of session]

📊 Session Statistics

Session Info
Session ID:              abc-123
Provider:                openai
Model:                   gpt-4
Messages:                23

Tool Calls
Total:                   45 ( ✓ 42 ✗ 3 )

Tokens
Prompt:                  12,450
Completion:              8,234
```

**Gaps:**
- Only shown at end, not during session
- No real-time budget tracking
- No visual progress bars
- No warnings when approaching limits
- No per-message breakdown visible
- Stats not persistent in header

---

### 9. Multi-Panel Layout ❌ MAJOR GAP

**Industry Standard (Cursor/GitHub Copilot workspace mode):**
```
┌─────────────────────┬─────────────────────────────────────────┐
│ Files (3)           │ 🤖 Meer AI: Agent is analyzing...      │
├─────────────────────┤                                         │
│ > src/              │ I'll check the auth middleware.         │
│   ├ auth/           │                                         │
│   │ ├ login.ts      │ ┌─ read_file ─────────────────────┐   │
│   │ └ middleware.ts │ │ src/auth/middleware.ts          │   │
│   └ app.tsx         │ │ [content preview]               │   │
│                     │ └─────────────────────────────────┘   │
│ Changes (2)         │                                         │
│ ├ M src/auth/       │ Based on the code...                   │
│ │   login.ts        │                                         │
│ └ M src/app.tsx     │                                         │
│                     │                                         │
├─────────────────────┴─────────────────────────────────────────┤
│ > Type message...                            [Tokens: 2.4K] │
└───────────────────────────────────────────────────────────────┘
```

**Your Current:**
```
[Single column, everything scrolls]
```

**Gaps:**
- No split-pane views
- No file tree sidebar
- No dedicated tool output panel
- Everything in single scroll
- No workspace awareness
- No persistent context panels

---

### 10. Keyboard Shortcuts & Help ❌ MINOR GAP

**Industry Standard:**
```
┌─ Keyboard Shortcuts ────────────────────────────────────┐
│ Ctrl+P    Toggle Plan/Edit mode                        │
│ Ctrl+L    Clear screen                                 │
│ Ctrl+K    Open command palette                         │
│ Esc       Interrupt agent                              │
│ ↑/↓       Navigate history                             │
│ Ctrl+R    Search history                               │
│ Ctrl+F    Find in conversation                         │
│ Alt+Enter Multi-line input                             │
└─────────────────────────────────────────────────────────┘
```

**Your Current:**
```
Enter to send • ESC to interrupt • Ctrl+P to toggle mode • Ctrl+C to exit
```

**Gaps:**
- Limited shortcuts
- No command palette
- No search in conversation
- No multi-line input
- Help not always visible
- No customizable shortcuts

---

## Priority Ranking: What to Fix First

### 🔴 CRITICAL (Must Have)

1. **Tool Execution Visualization** (P0)
   - Users need to see what's happening
   - Professional tools ALL have this
   - Direct impact on perceived performance

2. **Main Screen Layout** (P0)
   - Persistent header with context
   - Clear visual hierarchy
   - Foundation for everything else

3. **Agent Workflow Visualization** (P0)
   - Progress indicators
   - Task breakdown
   - Users feeling "in the loop"

### 🟡 HIGH PRIORITY (Should Have)

4. **Streaming Response UI** (P1)
   - Real-time feedback feels faster
   - Token/cost tracking during stream
   - Industry expectation

5. **File/Code Diffs** (P1)
   - Core to coding assistant UX
   - Inline diffs are table stakes
   - Navigation and partial accept critical

6. **Error Handling** (P1)
   - Errors should be actionable
   - Context helps debugging
   - Retry/recovery options expected

### 🟢 MEDIUM PRIORITY (Nice to Have)

7. **Interactive File Picker** (P2)
   - Current works, but basic
   - Rich UI improves UX
   - Not blocking core workflows

8. **Token/Cost Tracking** (P2)
   - Already shown at end
   - Real-time is better
   - Visual budget helps users

9. **Multi-Panel Layout** (P2)
   - Advanced feature
   - Complex to implement
   - More "pro" than essential

10. **Keyboard Shortcuts** (P3)
    - Power user feature
    - Current shortcuts work
    - Nice polish but not critical

---

## Recommended Implementation Plan

### Phase 1: Foundation (Week 1-2) - Make Ink the Default

**Goal:** Migrate fully to Ink-based UI, deprecate legacy

**Tasks:**
```typescript
// 1. Make Ink the default UI
// File: src/index.ts or main entry point
import { InkChatAdapter } from './ui/ink/InkChatAdapter.js';

// Replace ChatBoxUI.handleInput with Ink
const ui = new InkChatAdapter({ provider, model, cwd });

// 2. Update workflow to use Ink timeline
const timeline = ui.getTimelineAdapter();
await workflow.processMessage(input, { timeline });

// 3. Migrate all interactions to Ink
// - File pickers
// - Confirmations
// - Progress indicators
```

**Components to build:**
1. `ToolExecutionPanel.tsx` - Shows tools running
2. `StatusHeader.tsx` - Persistent top bar
3. `ProgressIndicator.tsx` - Visual progress bars
4. `InteractivePrompt.tsx` - Rich prompts

**Deliverables:**
- ✅ Ink UI is default (remove feature flag)
- ✅ All features work in Ink
- ✅ Legacy UI removed or deprecated
- ✅ Basic tool visualization working

---

### Phase 2: Tool Visualization (Week 3-4)

**Goal:** Professional tool execution display

**Implementation:**
```typescript
// File: src/ui/ink/ToolExecutionPanel.tsx
import React, { useState } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';

interface ToolCall {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'success' | 'error';
  startTime?: number;
  endTime?: number;
  result?: string;
  error?: string;
}

export const ToolExecutionPanel: React.FC<{
  tools: ToolCall[];
  isParallel?: boolean;
}> = ({ tools, isParallel = false }) => {
  const getIcon = (status: ToolCall['status']) => {
    switch (status) {
      case 'pending': return '⏸';
      case 'running': return <Spinner type="dots" />;
      case 'success': return '✓';
      case 'error': return '✗';
    }
  };

  const getDuration = (tool: ToolCall) => {
    if (!tool.startTime) return '';
    const end = tool.endTime || Date.now();
    return `${end - tool.startTime}ms`;
  };

  const getColor = (status: ToolCall['status']) => {
    switch (status) {
      case 'running': return 'yellow';
      case 'success': return 'green';
      case 'error': return 'red';
      default: return 'gray';
    }
  };

  if (tools.length === 0) return null;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      marginY={1}
    >
      <Box>
        <Text color="cyan" bold>
          🔧 Tools ({tools.length}) {isParallel && <Text color="yellow">⚡ Parallel</Text>}
        </Text>
      </Box>

      {tools.map((tool) => (
        <Box key={tool.id} justifyContent="space-between">
          <Box>
            <Text color={getColor(tool.status)}>
              {getIcon(tool.status)} {tool.name}
            </Text>
          </Box>
          <Text color="gray" dimColor>
            {getDuration(tool)}
          </Text>
        </Box>
      ))}

      {/* Collapsible results */}
      <Box marginTop={1}>
        <Text color="gray" dimColor>
          Press 't' to toggle tool details
        </Text>
      </Box>
    </Box>
  );
};
```

**Features:**
- Real-time tool status updates
- Parallel vs sequential indicators
- Timing information
- Collapsible results
- Error states clearly shown

**Deliverables:**
- ✅ Tool execution panel component
- ✅ Integrated into main workflow
- ✅ Timing tracked and displayed
- ✅ Collapsible tool results

---

### Phase 3: Streaming & Feedback (Week 5)

**Goal:** Real-time response feedback

**Implementation:**
```typescript
// File: src/ui/ink/StreamingResponse.tsx
import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';

export const StreamingResponse: React.FC<{
  content: string;
  isStreaming: boolean;
  tokens: { input: number; output: number };
  cost: number;
  elapsed: number;
}> = ({ content, isStreaming, tokens, cost, elapsed }) => {
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setCursor((prev) => (prev + 1) % 4);
    }, 200);
    return () => clearInterval(interval);
  }, []);

  return (
    <Box flexDirection="column">
      {/* Streaming indicator */}
      {isStreaming && (
        <Box>
          <Text color="yellow">
            Generating{'.'.repeat(cursor)} {elapsed.toFixed(1)}s
          </Text>
        </Box>
      )}

      {/* Content with syntax highlighting */}
      <Box>
        <Text>{content}</Text>
      </Box>

      {/* Real-time token counter */}
      <Box marginTop={1} justifyContent="space-between">
        <Text color="gray" dimColor>
          Tokens: {tokens.input} → {tokens.output} [+{tokens.output - tokens.input}]
        </Text>
        {cost > 0 && (
          <Text color="gray" dimColor>
            Cost: ${cost.toFixed(4)}
          </Text>
        )}
      </Box>
    </Box>
  );
};
```

**Deliverables:**
- ✅ Streaming progress indicator
- ✅ Real-time token counter
- ✅ Cost accumulation visible
- ✅ Elapsed time shown

---

### Phase 4: Enhanced Diffs (Week 6)

**Goal:** Professional diff viewing

**Implementation:**
```typescript
// File: src/ui/ink/DiffViewer.tsx
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { diffLines } from 'diff';

export const DiffViewer: React.FC<{
  oldContent: string;
  newContent: string;
  filePath: string;
  onAccept: () => void;
  onReject: () => void;
}> = ({ oldContent, newContent, filePath, onAccept, onReject }) => {
  const [view, setView] = useState<'unified' | 'split'>('unified');
  const [currentHunk, setCurrentHunk] = useState(0);

  const diff = diffLines(oldContent, newContent);
  const hunks = groupDiffIntoHunks(diff);

  useInput((input, key) => {
    if (input === 'a') onAccept();
    if (input === 'r') onReject();
    if (input === 'v') setView(view === 'unified' ? 'split' : 'unified');
    if (key.upArrow) setCurrentHunk(Math.max(0, currentHunk - 1));
    if (key.downArrow) setCurrentHunk(Math.min(hunks.length - 1, currentHunk + 1));
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Box justifyContent="space-between">
        <Text color="yellow" bold>📝 Changes to {filePath}</Text>
        <Text color="gray">({view} view)</Text>
      </Box>

      {/* Diff content */}
      <Box flexDirection="column" marginY={1}>
        {renderHunk(hunks[currentHunk], view)}
      </Box>

      {/* Navigation */}
      <Box justifyContent="space-between">
        <Text color="gray" dimColor>
          Hunk {currentHunk + 1} of {hunks.length}
        </Text>
        <Text color="gray" dimColor>
          [a]ccept [r]eject [v]iew [↑↓]navigate
        </Text>
      </Box>
    </Box>
  );
};

function groupDiffIntoHunks(diff: any[]): any[] {
  // Group changes into hunks with context
  // Implementation details...
  return [];
}

function renderHunk(hunk: any, view: 'unified' | 'split') {
  // Render hunk based on view mode
  // Implementation details...
  return null;
}
```

**Deliverables:**
- ✅ Inline diff viewer
- ✅ Side-by-side option
- ✅ Hunk navigation
- ✅ Line numbers
- ✅ Syntax highlighting

---

### Phase 5: Workflow Progress (Week 7)

**Goal:** Show agent thinking process

**Implementation:**
```typescript
// File: src/ui/ink/WorkflowProgress.tsx
import React from 'react';
import { Box, Text } from 'ink';

interface WorkflowStage {
  name: string;
  status: 'pending' | 'running' | 'complete' | 'error';
  startTime?: number;
  endTime?: number;
}

export const WorkflowProgress: React.FC<{
  stages: WorkflowStage[];
  currentIteration: number;
  maxIterations: number;
}> = ({ stages, currentIteration, maxIterations }) => {
  const progress = (currentIteration / maxIterations) * 100;
  const completedStages = stages.filter(s => s.status === 'complete').length;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="blue"
      paddingX={1}
      marginY={1}
    >
      <Box justifyContent="space-between">
        <Text color="blue" bold>🔄 Workflow Progress</Text>
        <Text color="gray">Iteration {currentIteration}/{maxIterations}</Text>
      </Box>

      {/* Progress bar */}
      <Box marginY={1}>
        <ProgressBar value={progress} width={50} />
      </Box>

      {/* Stages */}
      <Box flexDirection="column">
        {stages.map((stage, idx) => (
          <Box key={idx}>
            <Text color={getStageColor(stage.status)}>
              {getStageIcon(stage.status)} {stage.name}
            </Text>
            {stage.endTime && stage.startTime && (
              <Text color="gray" dimColor>
                {' '}
                {stage.endTime - stage.startTime}ms
              </Text>
            )}
          </Box>
        ))}
      </Box>

      <Box marginTop={1}>
        <Text color="gray" dimColor>
          {completedStages}/{stages.length} stages complete
        </Text>
      </Box>
    </Box>
  );
};

const ProgressBar: React.FC<{ value: number; width: number }> = ({ value, width }) => {
  const filled = Math.round((value / 100) * width);
  const empty = width - filled;

  return (
    <Text color="cyan">
      {'█'.repeat(filled)}
      <Text color="gray" dimColor>
        {'░'.repeat(empty)}
      </Text>
      {' '}
      {value.toFixed(0)}%
    </Text>
  );
};

function getStageIcon(status: WorkflowStage['status']) {
  switch (status) {
    case 'pending': return '⏸';
    case 'running': return '⏳';
    case 'complete': return '✓';
    case 'error': return '✗';
  }
}

function getStageColor(status: WorkflowStage['status']) {
  switch (status) {
    case 'running': return 'yellow';
    case 'complete': return 'green';
    case 'error': return 'red';
    default: return 'gray';
  }
}
```

**Deliverables:**
- ✅ Workflow stages visualization
- ✅ Progress bar
- ✅ Time estimates
- ✅ Iteration tracking

---

### Phase 6: Polish & Advanced Features (Week 8-10)

**Goals:** Production-ready polish

**Tasks:**

1. **Persistent Status Header**
   ```typescript
   // Always visible at top
   ┌─ 🌊 Meer AI  │  gpt-4  │  ~/project  │  💰 $0.12  │  📊 4.2K ─┐
   ```

2. **Enhanced Error Handling**
   - Structured error displays
   - Retry/skip/abort options
   - Context and stack traces
   - Error history

3. **Token/Cost Dashboard**
   - Real-time budget tracking
   - Visual progress bars
   - Per-message breakdown
   - Session limits visible

4. **Command Palette** (Optional)
   ```
   Ctrl+K → Search all slash commands
   Fuzzy search
   Recently used
   Custom shortcuts
   ```

5. **Keyboard Shortcuts Help**
   - F1 or ? to show help
   - Contextual shortcuts
   - Customizable bindings

6. **Theme Support**
   - Light/dark themes
   - Custom color schemes
   - Accessibility modes

---

## Technical Architecture Recommendations

### 1. Component Structure

```
src/ui/ink/
├── components/
│   ├── core/
│   │   ├── Header.tsx              (Persistent header)
│   │   ├── StatusBar.tsx           (Bottom status)
│   │   ├── InputArea.tsx           (Enhanced input)
│   │   └── MessageList.tsx         (Scrollable messages)
│   ├── tools/
│   │   ├── ToolExecutionPanel.tsx  (Tool visualization)
│   │   ├── ToolResultView.tsx      (Collapsible results)
│   │   └── ToolProgress.tsx        (Individual tool progress)
│   ├── workflow/
│   │   ├── WorkflowProgress.tsx    (Agent workflow stages)
│   │   ├── IterationTracker.tsx    (Iteration counter)
│   │   └── PlanView.tsx            (Plan mode visualization)
│   ├── diff/
│   │   ├── DiffViewer.tsx          (Inline diff)
│   │   ├── SideBySideDiff.tsx      (Split view)
│   │   └── HunkNavigator.tsx       (Diff navigation)
│   ├── streaming/
│   │   ├── StreamingResponse.tsx   (Real-time feedback)
│   │   ├── TokenCounter.tsx        (Live token count)
│   │   └── CostTracker.tsx         (Cost accumulation)
│   ├── error/
│   │   ├── ErrorPanel.tsx          (Structured errors)
│   │   ├── ErrorActions.tsx        (Retry/skip/abort)
│   │   └── ErrorHistory.tsx        (Error log)
│   └── shared/
│       ├── ProgressBar.tsx         (Reusable progress)
│       ├── CodeBlock.tsx           (Syntax highlighted code)
│       ├── Collapsible.tsx         (Expandable sections)
│       └── Spinner.tsx             (Custom spinners)
├── layouts/
│   ├── SinglePanelLayout.tsx       (Default)
│   ├── SplitPanelLayout.tsx        (Future: workspace mode)
│   └── FullScreenLayout.tsx        (Focused mode)
├── hooks/
│   ├── useKeyboardShortcuts.ts     (Keyboard handling)
│   ├── useTheme.ts                 (Theme context)
│   ├── useWorkflowState.ts         (Workflow tracking)
│   └── useToolTracking.ts          (Tool state)
└── MeerChat.tsx                    (Main container)
```

### 2. State Management

```typescript
// Use React Context for global state
// File: src/ui/ink/contexts/WorkflowContext.tsx

interface WorkflowState {
  // Current workflow state
  stage: 'idle' | 'thinking' | 'tool_execution' | 'waiting';
  iteration: number;
  maxIterations: number;

  // Tool tracking
  tools: ToolCall[];
  activeTool: string | null;

  // Metrics
  tokens: { input: number; output: number };
  cost: number;
  elapsed: number;

  // UI state
  mode: 'edit' | 'plan';
  theme: 'dark' | 'light';

  // Actions
  addTool: (tool: ToolCall) => void;
  updateTool: (id: string, updates: Partial<ToolCall>) => void;
  setStage: (stage: WorkflowState['stage']) => void;
}

export const WorkflowContext = React.createContext<WorkflowState | null>(null);

export const WorkflowProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<WorkflowState>({
    // ... initial state
  });

  // Provide state and actions
  return (
    <WorkflowContext.Provider value={state}>
      {children}
    </WorkflowContext.Provider>
  );
};

export function useWorkflow() {
  const context = useContext(WorkflowContext);
  if (!context) throw new Error('useWorkflow must be used within WorkflowProvider');
  return context;
}
```

### 3. Event System

```typescript
// File: src/ui/ink/events.ts

// Event bus for UI updates
type UIEvent =
  | { type: 'tool_started'; data: { toolName: string; id: string } }
  | { type: 'tool_completed'; data: { id: string; result: string; duration: number } }
  | { type: 'tool_failed'; data: { id: string; error: string } }
  | { type: 'workflow_stage_changed'; data: { stage: string } }
  | { type: 'token_update'; data: { input: number; output: number } }
  | { type: 'cost_update'; data: { cost: number } }
  | { type: 'iteration_changed'; data: { current: number; max: number } };

class UIEventBus {
  private listeners = new Map<string, Set<(event: UIEvent) => void>>();

  on(type: string, handler: (event: UIEvent) => void) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(handler);
  }

  off(type: string, handler: (event: UIEvent) => void) {
    this.listeners.get(type)?.delete(handler);
  }

  emit(event: UIEvent) {
    this.listeners.get(event.type)?.forEach((handler) => handler(event));
    this.listeners.get('*')?.forEach((handler) => handler(event));
  }
}

export const uiEvents = new UIEventBus();
```

### 4. Integration with Workflow

```typescript
// File: src/agent/workflow-v2.ts (modifications)

class AgentWorkflowV2 {
  private uiAdapter?: InkChatAdapter;

  async processMessage(userMessage: string, options?: { ui?: InkChatAdapter }) {
    this.uiAdapter = options?.ui;

    // Emit UI events throughout workflow
    this.emitUIEvent({ type: 'workflow_stage_changed', data: { stage: 'analyzing' } });

    // When executing tools
    for (const toolCall of toolCalls) {
      const toolId = `tool-${Date.now()}`;

      this.emitUIEvent({
        type: 'tool_started',
        data: { toolName: toolCall.tool, id: toolId }
      });

      const startTime = Date.now();
      const result = await this.executeTool(toolCall);
      const duration = Date.now() - startTime;

      this.emitUIEvent({
        type: 'tool_completed',
        data: { id: toolId, result, duration }
      });
    }

    // Update tokens
    this.emitUIEvent({
      type: 'token_update',
      data: { input: promptTokens, output: completionTokens }
    });
  }

  private emitUIEvent(event: UIEvent) {
    if (this.uiAdapter) {
      this.uiAdapter.handleWorkflowEvent(event);
    }
  }
}
```

---

## Comparison with Industry Leaders

### GitHub Copilot CLI

**What they do well:**
- ✅ Clear command structure (`gh copilot suggest`, `gh copilot explain`)
- ✅ Inline suggestions with syntax highlighting
- ✅ Token-by-token streaming
- ✅ Copy/paste actions built-in
- ✅ Great onboarding flow

**What you can match:**
- Tool execution visualization
- Streaming with syntax highlighting
- Clear command palette
- Keyboard shortcuts

**Where you can differentiate:**
- Multi-turn conversations (they're single-shot)
- File editing workflow (they only suggest)
- MCP tool integration (you have this!)
- Local-first option (privacy)

### Claude Code (Cursor)

**What they do well:**
- ✅ Beautiful split-pane UI
- ✅ Inline diffs with accept/reject per hunk
- ✅ Workspace awareness (file tree)
- ✅ Real-time token counter
- ✅ Plan vs Edit mode distinction
- ✅ Multi-file editing

**What you can match:**
- Plan/Edit mode toggle (you have this!)
- Inline diffs
- Token tracking
- File editing workflow

**Where you can differentiate:**
- CLI-native (they're VSCode extension)
- MCP tool ecosystem
- Open source (transparency)
- Multi-provider support

### Cursor

**What they do well:**
- ✅ Command+K command palette
- ✅ Composer for multi-file edits
- ✅ Inline code generation
- ✅ Tab autocomplete
- ✅ Codebase indexing

**What you can match:**
- Command palette
- Multi-file editing workflow
- Project analysis

**Where you can differentiate:**
- Terminal-native workflow
- Script automation (they're IDE-only)
- Lightweight (no IDE needed)
- Pipeline integration

---

## Success Metrics

### User Experience Metrics

1. **Task Completion Time**
   - Baseline: Current implementation
   - Target: 30% faster perceived time
   - Measure: Time to complete common tasks

2. **User Confidence**
   - Baseline: Survey current users
   - Target: "I always know what's happening" > 90%
   - Measure: Post-session surveys

3. **Error Recovery Rate**
   - Baseline: How often users restart after error
   - Target: 80% recovery without restart
   - Measure: Error → successful completion

4. **Feature Discovery**
   - Baseline: % of users using slash commands
   - Target: 70% use at least 3 different commands
   - Measure: Command usage analytics

### Technical Metrics

1. **Rendering Performance**
   - Target: < 16ms per frame (60 FPS)
   - Measure: Ink render time

2. **Memory Usage**
   - Target: < 100MB for typical session
   - Measure: Process memory

3. **Startup Time**
   - Target: < 500ms to first render
   - Measure: Time from launch to ready

---

## Migration Strategy: Legacy → Ink

### Phase A: Parallel Mode (Week 1-2)

```typescript
// Add feature flag
const USE_INK_UI = process.env.MEER_UI === 'ink' || false;

if (USE_INK_UI) {
  // Use new Ink UI
  const ui = new InkChatAdapter({ provider, model, cwd });
  await runWithInk(ui);
} else {
  // Use legacy UI
  await runWithLegacyUI();
}
```

**Goal:** Both UIs work, opt-in to new

### Phase B: Ink Default (Week 3-4)

```typescript
// Flip default, but allow fallback
const USE_INK_UI = process.env.MEER_UI !== 'legacy';
```

**Goal:** New UI is default, legacy available as escape hatch

### Phase C: Legacy Deprecated (Week 5-6)

```typescript
if (process.env.MEER_UI === 'legacy') {
  console.warn('Legacy UI is deprecated and will be removed in v0.8.0');
}
```

**Goal:** Warn users, prepare for removal

### Phase D: Legacy Removed (v0.8.0+)

```typescript
// Remove ChatBoxUI entirely
// Remove all readline/inquirer code
// Ink is the only UI
```

**Goal:** Clean codebase, single UI system

---

## Risk Mitigation

### Risk 1: Ink Performance with Large Outputs

**Mitigation:**
- Virtualized scrolling (only render visible)
- Pagination for large results
- Lazy loading of tool results
- Streaming with backpressure

### Risk 2: Terminal Compatibility

**Mitigation:**
- Feature detection (check for TTY)
- Graceful degradation to simple mode
- Test on: iTerm2, Terminal.app, Windows Terminal, Alacritty
- Fallback to legacy for unsupported terminals

### Risk 3: Increased Complexity

**Mitigation:**
- Clear component boundaries
- Comprehensive testing
- Documentation for contributors
- Gradual rollout with feature flags

### Risk 4: User Resistance to Change

**Mitigation:**
- Communicate changes early
- Show benefits (faster, clearer, more professional)
- Keep opt-out option initially
- Gather feedback and iterate

---

## Testing Strategy

### Unit Tests

```typescript
// Test individual components
describe('ToolExecutionPanel', () => {
  it('shows running tools with spinner', () => {
    const tools = [{
      id: '1',
      name: 'read_file',
      status: 'running',
      startTime: Date.now()
    }];

    const { lastFrame } = render(<ToolExecutionPanel tools={tools} />);
    expect(lastFrame()).toContain('read_file');
  });
});
```

### Integration Tests

```typescript
// Test full workflows
describe('Agent workflow with Ink UI', () => {
  it('shows tool execution through completion', async () => {
    const ui = new InkChatAdapter({ provider, model, cwd });
    const workflow = new AgentWorkflowV2({ provider, cwd, ui });

    await workflow.processMessage('list files in src/');

    // Verify UI showed tool execution
    expect(ui.getState()).toMatchObject({
      tools: expect.arrayContaining([
        expect.objectContaining({ name: 'list_files', status: 'complete' })
      ])
    });
  });
});
```

### Manual Testing Checklist

- [ ] All slash commands work
- [ ] File picker shows and filters correctly
- [ ] Diffs display properly
- [ ] Tool execution shows progress
- [ ] Keyboard shortcuts work
- [ ] Error handling is clear
- [ ] Mode switching works
- [ ] Token/cost tracking accurate
- [ ] Works on multiple terminals
- [ ] Handles Ctrl+C gracefully
- [ ] Scrolling works with long outputs
- [ ] Syntax highlighting correct

---

## Future Enhancements (Beyond Initial Plan)

### 1. Workspace Mode (Multi-Panel)

```
┌─ Files ─────┬─ Chat ──────────────┬─ Tools ─────┐
│ src/        │ 🤖: Analyzing...    │ ✓ read_file │
│ > auth/     │                     │ ⏳ grep     │
│   tests/    │ Based on...         │             │
└─────────────┴─────────────────────┴─────────────┘
```

### 2. Live Collaboration

- Share session with team member
- Watch agent work in real-time
- Review and approve changes together

### 3. Session Replay

- Record UI sessions
- Playback for debugging
- Export as animated GIF/video

### 4. Plugin System for Custom Panels

```typescript
// Allow third-party UI extensions
export interface PanelPlugin {
  name: string;
  component: React.FC<{ state: WorkflowState }>;
  position: 'left' | 'right' | 'bottom';
}

meer.registerPanel({
  name: 'Custom Metrics',
  component: MyMetricsPanel,
  position: 'right'
});
```

### 5. Voice Input/Output

- Text-to-speech for responses
- Speech-to-text for input
- Accessibility enhancement

---

## Resources & Learning

### Ink Documentation & Examples

- [Ink GitHub](https://github.com/vadimdemedes/ink)
- [Ink UI Components](https://github.com/vadimdemedes/ink-ui)
- [Pastel (Ink Framework)](https://github.com/vadimdemedes/pastel)

### Inspiration from Other CLIs

- **GitHub CLI** - Rich interactive prompts
- **Vercel CLI** - Great deployment UX
- **Warp Terminal** - Modern terminal features
- **Fig** - Autocomplete and suggestions

### Design Systems for CLIs

- [Charm](https://charm.sh/) - Bubbletea, Lipgloss, Bubbles
- [Textual](https://github.com/Textualize/textual) - Python TUIs
- [tview](https://github.com/rivo/tview) - Go TUI framework

---

## Conclusion

Your CLI has a **solid foundation** with Ink already integrated, but it's underutilized. The path forward:

**Short term (4-6 weeks):**
1. ✅ Make Ink the default UI
2. ✅ Add tool execution visualization
3. ✅ Improve streaming feedback
4. ✅ Better diffs and error handling

**Medium term (2-3 months):**
5. ✅ Workflow progress indicators
6. ✅ Real-time token/cost tracking
7. ✅ Enhanced keyboard shortcuts
8. ✅ Theme support

**Long term (6+ months):**
9. ✅ Multi-panel workspace mode
10. ✅ Plugin system
11. ✅ Advanced features (replay, collaboration)

**Key success factors:**
- Migrate fully to Ink (deprecate legacy)
- Focus on tool visualization (biggest gap)
- Real-time feedback throughout
- Progressive disclosure (hide complexity)
- Professional polish (match Claude Code/Copilot)

With focused effort, Meer CLI can have industry-leading TUI that rivals or exceeds Claude Code and GitHub Copilot CLI while maintaining its unique advantages (MCP tools, local-first, multi-provider).
