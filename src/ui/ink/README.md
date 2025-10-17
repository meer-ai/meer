# Modern Ink-based TUI for Meer AI

A beautiful, modern Terminal User Interface built with [Ink](https://github.com/vadimdemedes/ink) (React for CLIs) - inspired by Claude Code, Cursor, and Bubble Tea.

## Features

✨ **Beautiful Design**
- Gradient headers with rainbow colors
- Syntax-highlighted code blocks
- Clean message bubbles with role indicators
- Smooth scrolling and animations
- Professional borders and spacing

🎯 **User Experience**
- Real-time streaming responses
- Keyboard shortcuts (Ctrl+C to exit, Ctrl+L to clear, arrows to scroll)
- Tool execution indicators
- Status bar with spinner animations
- Responsive layout that adapts to terminal size

🛠️ **Developer-Friendly**
- Drop-in replacement for `OceanChatUI`
- Same API, better UX
- TypeScript support with full type safety
- React component architecture

## Usage

### Basic Usage with InkChatAdapter

Replace your `OceanChatUI` with `InkChatAdapter`:

\`\`\`typescript
import { InkChatAdapter } from './ui/ink/index.js';

// Create the UI
const ui = new InkChatAdapter({
  provider: 'openai',
  model: 'gpt-4',
  cwd: process.cwd(),
});

// Use it just like OceanChatUI
ui.appendUserMessage('Hello!');
ui.startAssistantMessage();
ui.appendAssistantChunk('Hi there!');
ui.finishAssistantMessage();

// Enable continuous chat mode
ui.enableContinuousChat((message) => {
  console.log('User said:', message);
  // Handle the message...
});

// Clean up when done
ui.destroy();
\`\`\`

### Direct Usage with React Component

For more control, use the React component directly:

\`\`\`typescript
import { renderMeerChat } from './ui/ink/index.js';

const { unmount, addMessage, setThinking } = renderMeerChat({
  provider: 'anthropic',
  model: 'claude-3-5-sonnet',
  cwd: '/path/to/project',
  onMessage: async (message) => {
    setThinking(true);
    // Process message...
    addMessage({
      role: 'assistant',
      content: 'Response here',
      timestamp: Date.now(),
    });
    setThinking(false);
  },
  onExit: () => {
    console.log('User exited');
    process.exit(0);
  },
});

// Add messages
addMessage({
  role: 'system',
  content: 'Welcome to Meer AI!',
});

// Clean up
unmount();
\`\`\`

## Components

### MeerChat

Main chat component with full UI:

\`\`\`tsx
<MeerChat
  messages={messages}
  isThinking={false}
  status="Processing..."
  provider="openai"
  model="gpt-4"
  cwd="/path/to/project"
  onMessage={(msg) => console.log(msg)}
  onExit={() => process.exit(0)}
/>
\`\`\`

### InkChatAdapter

Adapter that provides the same API as `OceanChatUI` but with the beautiful Ink UI underneath.

## Message Types

The UI supports different message types with appropriate styling:

- **User messages**: Cyan color with `❯` icon
- **Assistant messages**: Green color with `🤖` icon
- **System messages**: Yellow color with `ℹ️` icon
- **Tool messages**: Yellow bordered box with `🛠️` icon

## Code Blocks

Code blocks are automatically detected and rendered in styled boxes:

\`\`\`
Here's some code:

\`\`\`typescript
function hello() {
  console.log('Hello!');
}
\`\`\`
\`\`\`

## Keyboard Shortcuts

- **Enter**: Send message (queues if agent is working)
- **Ctrl+P**: Toggle between Plan and Edit modes
- **ESC**: Interrupt agent execution
- **Ctrl+C**: Exit
- **Ctrl+L**: Clear screen (when implemented)
- **↑/↓**: Scroll through messages

## Advanced Features

### Plan Mode vs Edit Mode

The UI supports two distinct modes that control how the AI agent interacts with your code:

#### 📋 Plan Mode (Read-Only)
In plan mode, the AI:
- **Analyzes** your code and project structure
- **Provides** detailed plans, suggestions, and explanations
- **Does NOT** make any file modifications
- **Can read** files to understand context
- **Helps with** architecture decisions, refactoring plans, debugging strategies

Use plan mode when you want to:
- Understand existing code
- Get recommendations before making changes
- Discuss architecture and design patterns
- Plan complex refactoring
- Review potential approaches

#### ✏️ Edit Mode (Read-Write)
In edit mode, the AI:
- **Can read AND modify** files
- **Makes changes** based on your requests
- **Creates new** files when needed
- **Executes** code modifications and implementations

Use edit mode when you want to:
- Implement features
- Fix bugs
- Refactor code
- Generate new code

#### Switching Modes

**Keyboard Shortcut:** Press **Ctrl+P** to toggle between modes at any time

**Visual Indicators:**
- Header shows: `📋 PLAN MODE` (blue) or `✏️ EDIT MODE` (green)
- Input hint shows current mode capabilities
- System message confirms mode switch

**Programmatic Access:**
```typescript
const ui = new InkChatAdapter({ provider, model, cwd });

// Get current mode
const currentMode = ui.getMode(); // 'edit' | 'plan'

// Set mode
ui.setMode('plan'); // Switch to plan mode
ui.setMode('edit'); // Switch to edit mode

// Listen to mode changes
ui.setModeChangeHandler((mode) => {
  console.log(`Mode changed to: ${mode}`);
  // Adjust agent behavior based on mode
});
```

### Message Queueing
When the agent is processing a message, you can type and send additional messages. They will be automatically queued and sent sequentially after the agent finishes:

1. Agent is working on your first question
2. You type and send a second message → It gets queued
3. First response completes → Second message is automatically sent
4. Indicator shows: `(X queued)` where X is the number of pending messages

### Agent Interruption
Press **ESC** at any time to interrupt the agent's current execution. This is useful when:
- The agent is taking too long
- You realize you need to ask a different question
- The agent is heading in the wrong direction

To enable interrupt handling in your CLI integration:
```typescript
const ui = new InkChatAdapter({ provider, model, cwd });
ui.setInterruptHandler(() => {
  // Handle interruption (e.g., abort agent execution)
  console.log('Agent interrupted by user');
});
```

## Comparison with OceanChatUI

| Feature | OceanChatUI (blessed) | InkChatAdapter (Ink) |
|---------|----------------------|---------------------|
| Visual Quality | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| Performance | Good | Excellent |
| Code Maintenance | Complex | Simple (React) |
| Code Blocks | Basic | Syntax-highlighted |
| Animations | Limited | Smooth |
| Gradients | No | Yes |
| Responsiveness | Manual | Automatic |

## Migration Guide

To migrate from `OceanChatUI` to `InkChatAdapter`:

1. Change the import:
   \`\`\`typescript
   // Old
   import { OceanChatUI } from './ui/oceanChat.js';

   // New
   import { InkChatAdapter } from './ui/ink/index.js';
   \`\`\`

2. Update the constructor:
   \`\`\`typescript
   // Old
   const ui = new OceanChatUI({ provider, model, cwd, showWorkflowPanel: false });

   // New
   const ui = new InkChatAdapter({ provider, model, cwd });
   \`\`\`

3. That's it! The API is identical.

## Future Enhancements

- [ ] File mention autocomplete with fuzzy search
- [ ] Slash command palette
- [ ] Better syntax highlighting with prism.js
- [ ] Split pane view for code diff
- [ ] Minimap for long conversations
- [ ] Search within conversation
- [ ] Export conversation to markdown
- [ ] Theme customization
- [ ] Mouse support for clicking links

## Contributing

The Ink UI is built with modern React patterns. To add new features:

1. Add new components in `src/ui/ink/`
2. Update `MeerChat.tsx` to use the new components
3. Update `InkChatAdapter.ts` if API changes are needed
4. Build with `npm run build`
5. Test with your CLI

## Credits

Built with:
- [Ink](https://github.com/vadimdemedes/ink) - React for CLIs
- [ink-spinner](https://github.com/vadimdemedes/ink-spinner) - Spinners
- [ink-text-input](https://github.com/vadimdemedes/ink-text-input) - Text input
- [ink-gradient](https://github.com/sindresorhus/ink-gradient) - Gradient text
- [ink-big-text](https://github.com/sindresorhus/ink-big-text) - Large text

Inspired by:
- [Claude Code](https://claude.ai/code) - Anthropic's coding assistant
- [Cursor](https://cursor.sh/) - AI-first code editor
- [Bubble Tea](https://github.com/charmbracelet/bubbletea) - Go TUI framework
