# TUI & Workflow Refactor - Production-Ready Architecture

**Status:** 🚧 In Progress  
**Created:** 2026-01-04  
**Goal:** Make MeerAI CLI TUI as smooth and responsive as Claude Code and Gemini CLI

---

## 📊 Overview

This document outlines the complete refactoring of the TUI and workflow system to achieve production-ready quality comparable to Claude Code and Gemini CLI.

### Current Issues

1. **Performance Problems**
   - 100+ re-renders per second during streaming
   - No debouncing of high-frequency updates
   - Synchronous state updates causing UI stuttering
   - Missing memoization for components

2. **UX Issues**
   - Scroll position jumps on new messages
   - No multi-line input support
   - Double character input (both TextInput and useInput handling keystrokes)
   - No smooth scrolling animations

3. **Architecture Issues**
   - Tight coupling between workflow and UI
   - No centralized state management
   - Callback-based approach instead of reactive state
   - Missing proper error boundaries and recovery

---

## 🎯 Target Architecture

### Core Principles

1. **Separation of Concerns**
   - Workflow Engine: Pure business logic, no UI dependencies
   - TUI Components: Pure React components, no workflow logic
   - State Management: Centralized, predictable state updates
   - Event Bus: Decoupled communication between layers

2. **Performance First**
   - Debounce all high-frequency updates (streaming, typing, etc.)
   - Memoize all components to prevent unnecessary re-renders
   - Virtualize long lists for smooth scrolling
   - Batch updates where possible

3. **Production Ready**
   - Proper error boundaries and recovery
   - Comprehensive keyboard shortcuts
   - Accessibility support (screen reader mode)
   - Progress tracking and metrics
   - Graceful degradation for different terminal capabilities

---

## 📁 New File Structure

```
src/
├── agent/
│   ├── workflow-v3.ts          # New production-ready workflow engine
│   ├── workflow-v2.ts          # Legacy (to be deprecated)
│   └── workflow.ts              # Legacy (to be deprecated)
├── ui/
│   ├── ink/
│   │   ├── contexts/
│   │   │   └── ChatContext.tsx         # Centralized state management
│   │   ├── components/
│   │   │   ├── core/
│   │   │   │   ├── StatusHeader.tsx
│   │   │   │   └── index.ts
│   │   │   ├── tools/
│   │   │   │   ├── ToolExecutionPanel.tsx
│   │   │   │   └── index.ts
│   │   │   ├── workflow/
│   │   │   │   ├── WorkflowProgress.tsx
│   │   │   │   └── index.ts
│   │   │   ├── plan/
│   │   │   │   ├── PlanPanel.tsx
│   │   │   │   └── index.ts
│   │   │   ├── timeline/
│   │   │   │   ├── TimelinePanel.tsx
│   │   │   │   └── index.ts
│   │   │   └── shared/
│   │   │       ├── VirtualizedList.tsx
│   │   │       ├── ScrollIndicator.tsx
│   │   │       └── index.ts
│   │   ├── MeerChatV2.tsx      # New optimized TUI component
│   │   ├── MeerChat.tsx         # Legacy (to be deprecated)
│   │   ├── AppContainer.tsx
│   │   └── utils/
│   │       └── debounce.ts         # Debounce utility
│   └── chatbox.ts              # Legacy CLI (consider deprecating)
└── commands/
    └── ask.ts                   # Updated to use new architecture
```

---

## 🔧 Component Architecture

### 1. State Management (ChatContext)

**File:** `src/ui/ink/contexts/ChatContext.tsx`

**Purpose:** Centralized, predictable state management using React Context API and useReducer

**Key Features:**
- Single source of truth for all TUI state
- Reducer-based state updates (no race conditions)
- Action-based state mutations (predictable, testable)
- Convenience hooks for different state slices:
  - `useChatState()` - Full state object
  - `useMessages()` - Message history
  - `useInput()` - Input field and history
  - `useStreaming()` - Streaming state and callbacks
  - `useTools()` - Active tools and history
  - `useWorkflow()` - Workflow stages and iterations
  - `useMetrics()` - Tokens, cost, message count
  - `useScroll()` - Scroll offset, anchor, and controls
  - `useSlashCommands()` - Slash command suggestions

**Benefits:**
- No prop drilling
- Predictable state updates
- Easy to test and debug
- Performance: Only affected components re-render

---

### 2. Workflow Engine (WorkflowV3)

**File:** `src/agent/workflow-v3.ts`

**Purpose:** Pure business logic for agent execution, completely decoupled from UI

**Key Features:**
- **Callback-based communication:** No UI dependencies, just pure logic
- **Parallel tool execution:** Read operations run concurrently
- **Sequential tool execution:** Write operations run in order with transaction safety
- **Transaction management:** Automatic rollback on errors
- **Session limits:** Token and cost tracking with warnings
- **Context management:** Smart pruning to prevent context overflow
- **Tool categorization:** Automatic parallel/sequential classification
- **Test detection:** Auto-run related tests after edits
- **Metrics tracking:** Iterations, tools executed, tokens, costs

**API:**
```typescript
class AgentWorkflowV3 {
  // Initialize with system prompt and MCP tools
  async initialize(contextPrompt?: string): Promise<void>
  
  // Process user message with full workflow
  async processMessage(userMessage: string): Promise<string>
  
  // Abort current execution
  abort(): void
  
  // Get workflow metrics
  getMetrics(): WorkflowMetrics
  
  // Reset for new session
  reset(): void
}
```

**Callbacks:**
- `onStreamingStart()` - Called when AI starts responding
- `onStreamingChunk(chunk)` - Called for each streaming chunk
- `onStreamingEnd()` - Called when streaming completes
- `onToolStart(tool, args)` - Called when tool starts
- `onToolUpdate(tool, status, result)` - Called with tool status updates
- `onToolEnd()` - Called when all tools complete
- `onStatusChange(status)` - Called for status updates
- `onError(error)` - Called on errors

---

### 3. TUI Components (MeerChatV2)

**File:** `src/ui/ink/MeerChatV2.tsx`

**Purpose:** Production-ready TUI component with optimal performance

**Key Features:**
- **Memoized components:** All sub-components wrapped with React.memo
- **Debounced updates:** Slash commands (150ms), streaming (50ms)
- **Separated input handling:** Only TextInput handles typing, useInput handles shortcuts
- **Scroll anchoring:** Smart auto-scroll that respects manual scroll position
- **Virtualized list:** Smooth scrolling for large message histories
- **Screen reader mode:** Accessibility support for screen readers
- **Keyboard shortcuts:**
  - Ctrl+C: Exit
  - Ctrl+P: Toggle edit/plan mode
  - ESC: Clear suggestions / interrupt
  - Tab: Navigate slash commands
  - Enter: Send message
  - Arrow keys: Navigate suggestions / history
  - Page Up/Down: Scroll messages
  - Ctrl+A: Jump to oldest message
  - Ctrl+E: Jump to latest message

**Sub-components (all memoized):**
- `Header` - Provider, model, mode display
- `StatusHeader` - Tokens, cost, message count, uptime
- `ToolExecutionPanel` - Active tools display
- `WorkflowProgress` - Workflow stages and iteration progress
- `PlanPanel` - Task plan display
- `TimelinePanel` - Timeline events display
- `VirtualizedList` - Efficient list rendering
- `ScrollIndicator` - Visual scroll position indicator
- `InputArea` - Input field with slash suggestions
- `ThinkingIndicator` - Animated thinking state
- `StatusBar` - Status message display
- `MessageView` - Individual message rendering
- `CodeBlock` - Syntax-highlighted code blocks
- `ToolCallView` - Tool execution display
- `ScreenReaderLayout` - Accessibility mode

---

## 🚀 Performance Optimizations

### 1. Debouncing

**File:** `src/ui/ink/utils/debounce.ts`

**Features:**
- Configurable delay and max wait
- Leading edge support (call immediately)
- Trailing edge support (call after delay)
- Max wait timeout (prevent starvation)
- Cancel and flush methods

**Usage:**
```typescript
// Debounce streaming chunks (50ms, max 200ms)
const debouncedAppend = debounce(appendChunk, {
  delay: 50,
  maxWait: 200,
  trailing: true
});

// Debounce slash command filtering (150ms)
const debouncedFilter = debounce(filterCommands, {
  delay: 150,
  trailing: true
});
```

### 2. Memoization Strategy

All components use `React.memo` with custom comparison functions:

```typescript
// Message comparison - only re-render if content changed
const MessageView = React.memo(({ message, isLast }) => { ... }, 
  (prev, next) => prev.id === next.id && prev.content === next.content
);

// Tool call comparison
const ToolCallView = React.memo(({ toolName, content }) => { ... },
  (prev, next) => prev.toolName === next.toolName && prev.content === next.content
);
```

### 3. Virtual Scrolling

**Benefits:**
- Only render visible items (e.g., 20 at a time)
- Smooth scroll with configurable window size
- Handles 1000+ messages without lag
- Preserves scroll position across updates

---

## 🎨 UX Improvements

### 1. Input Experience

**Multi-line Input (Future - Phase 2):**
- Support Shift+Enter for new lines
- Arrow key navigation between lines
- Word wrapping at terminal width
- Cursor position tracking

**Command History (Future - Phase 2):**
- Up/Down arrows navigate history
- Ctrl+R for fuzzy search
- Persistent across sessions (~/.meer/history.log)
- Auto-deduplication

### 2. Scroll Experience

**Features:**
- Smart auto-scroll (only when at bottom)
- Manual scroll indicator ("↓ New" when not at bottom)
- Page Up/Down with configurable page size
- Smooth animations (future - Phase 3)
- Mouse wheel support (future - Phase 3)

### 3. Status Indicators

**Real-time Updates:**
- Thinking state with animated dots
- Tool execution with live status updates
- Progress bars for long operations
- Token and cost tracking
- Session limits with warnings at 85%

### 4. Error Handling

**Graceful Degradation:**
- Try alternative approaches on tool failures
- Rollback transactions on errors
- Clear error messages with recovery suggestions
- Never crash - always recover to usable state
- Session limits with helpful messages

---

## 🔄 Migration Path

### Phase 1: Core Infrastructure (Week 1) ✅ IN PROGRESS

**Tasks:**
- [x] Create ChatContext with useReducer
- [x] Create debounce utility
- [x] Create WorkflowV3 engine
- [x] Create MeerChatV2 TUI component
- [ ] Update CLI commands to use new architecture
- [ ] Add comprehensive tests
- [ ] Update documentation

### Phase 2: Enhanced Features (Weeks 2-3)

**Tasks:**
- [ ] Multi-line input component
- [ ] Command history with navigation
- [ ] Smooth scroll animations
- [ ] Mouse support
- [ ] Performance monitoring dashboard
- [ ] Animated scrollbar
- [ ] Vim mode (optional)

### Phase 3: Polish (Weeks 4-5)

**Tasks:**
- [ ] Fuzzy search for slash commands
- [ ] Advanced keyboard shortcuts (Ctrl+K, Ctrl+L, etc.)
- [ ] Theme customization
- [ ] Plugin system for custom components
- [ ] Export/import sessions
- [ ] Advanced analytics dashboard

---

## 📈 Success Metrics

### Performance Targets

| Metric | Current | Target | Measurement |
|---------|---------|--------|-------------|
| Re-renders/sec (streaming) | 100+ | <20 | Component re-render count |
| Input lag (typing) | ~80ms | <50ms | Time from keystroke to render |
| Scroll FPS | Choppy | 60fps | Smoothness of scroll |
| Memory usage (idle) | Unknown | <200MB | Process memory |
| Component re-renders | High | -80% | Fewer unnecessary renders |

### UX Targets

| Metric | Current | Target | Measurement |
|---------|---------|--------|-------------|
| Feature parity with Gemini | ~60% | 90%+ | % of features implemented |
| Responsiveness score | 6/10 | 9/10 | User perception testing |
| Error recovery rate | Unknown | 95%+ | % of errors recovered gracefully |
| Accessibility compliance | Partial | Full | Screen reader, keyboard nav |

---

## 🧪 Testing Strategy

### Unit Tests

- State management: Reducer logic, action creators
- Debounce utility: Timing, cancellation
- Workflow engine: Tool execution, transaction management
- Components: Render behavior with mock props

### Integration Tests

- Full workflow: User message → tools → response
- Error scenarios: Tool failures, API errors, timeouts
- UI interactions: Keyboard shortcuts, scroll, slash commands
- Performance: Large message histories, rapid streaming

### Manual Testing Checklist

**Input:**
- [ ] Type normally during streaming (no lag)
- [ ] Paste long text (100+ lines)
- [ ] Type "/" for slash commands (instant filter)
- [ ] Use all keyboard shortcuts
- [ ] Navigate command history
- [ ] Multi-line input (Phase 2)

**Scroll:**
- [ ] Scroll up while new messages arrive (stable position)
- [ ] Scroll with Page Up/Down (smooth)
- [ ] Scroll with Ctrl+A / Ctrl+E (jump to ends)
- [ ] Scroll with mouse wheel (Phase 3)
- [ ] Drag scrollbar (Phase 3)

**Performance:**
- [ ] Stream 1000 tokens - no lag
- [ ] 100+ messages in history - smooth scroll
- [ ] 500 slash commands - instant filter
- [ ] Resize terminal - no flicker
- [ ] Tool execution - no screen flash

**Edge Cases:**
- [ ] Very long messages (10k+ characters)
- [ ] Rapid tool execution (10+ tools)
- [ ] Terminal resize during streaming
- [ ] Interrupt during long operation
- [ ] Low-spec hardware performance

---

## 📚 References

### Inspiration

- **Gemini CLI:** `D:\DevOps\gemini-cli`
  - Text Buffer: Multi-line editing
  - Keypress Context: Keyboard shortcuts
  - ScrollProvider: Smooth scrolling
  - VirtualizedList: Efficient rendering

- **Claude Code:** Production TUI
  - Smooth streaming with debouncing
  - Clean, minimal UI
  - Excellent keyboard shortcuts
  - Robust error handling

### Best Practices

- React Context API for state management
- React.memo for component optimization
- Debouncing for high-frequency updates
- Virtualization for long lists
- Separation of concerns (UI vs business logic)
- Callback-based communication for decoupling
- Accessibility-first design

---

## 📝 Implementation Notes

### Key Decisions

1. **Why useReducer instead of multiple useState?**
   - Single source of truth
   - Predictable state transitions
   - Easier to test and debug
   - Better performance (batched updates)

2. **Why separate WorkflowV3 from UI?**
   - Workflow can be tested independently
   - UI can be tested independently
   - Can swap implementations without touching UI
   - Enables different UIs for same workflow (web, desktop, etc.)

3. **Why debounce streaming?**
   - Prevents 100+ re-renders per second
   - Reduces CPU usage
   - Smoother UX (no flickering)

4. **Why virtualize messages?**
   - Handles 1000+ messages smoothly
   - Constant memory usage (only renders visible)
   - Faster scroll (fewer DOM nodes)

5. **Why scroll anchoring?**
   - Prevents scroll jumping when user is reading
   - Auto-scrolls only when user is at bottom
   - Better UX (user control over scroll position)

---

**Last Updated:** 2026-01-04  
**Maintained By:** Development Team  
**Review Frequency:** Weekly during active development
