# 💬 Chat Features

MeerAI now includes enhanced chat functionality with a modern UI and comprehensive session tracking.

## ✨ New Features

### 🎨 Chat Box UI
- **Bordered Input**: Clean, bordered input boxes for better visual clarity
- **Modern Interface**: Improved visual separation between user input and AI responses
- **Professional Look**: Similar to modern AI chat interfaces

### 📊 Session Statistics
- **Real-time Tracking**: Track messages, API calls, and tool usage
- **Performance Metrics**: Monitor wall time, agent active time, and success rates
- **Tool Breakdown**: Detailed statistics for each tool used

### ⚡ Enhanced Slash Commands

| Command | Description |
|---------|-------------|
| `/stats` | Show current session statistics |
| `/help` | Display available commands |
| `/exit` | End the chat session |
| `/init` | Create AGENTS.md for project tracking |
| `/setup` | Run setup wizard to reconfigure providers |
| `/provider` | Switch AI provider |
| `/model` | Switch AI model |

### 👋 Goodbye Experience
- **Session Summary**: Comprehensive overview when exiting
- **Professional Farewell**: Styled goodbye message with key metrics
- **Performance Report**: Wall time, agent activity, and success rates

## 🎯 Usage Examples

### Starting a Chat Session
```bash
# Interactive chat with enhanced UI
meer chat

# Main interface (with chat box UI)
meer
```

### During Chat
```bash
# Check current session stats
> /stats

# Get help
> /help

# Exit gracefully
> /exit
```

### Exit Behavior
- **Ctrl+C**: Shows goodbye message with session summary
- **`/exit` command**: Clean exit with statistics
- **`exit` or `quit`**: Traditional exit commands

## 📈 Session Metrics

The new session tracking provides detailed insights:

### **Session Info**
- Unique session ID
- Provider and model used
- Total messages exchanged

### **Tool Performance**
- Total tool calls with success/failure breakdown
- Success rate percentage
- Individual tool statistics

### **Timing Metrics**
- Wall time (total session duration)
- Agent active time (API + tool execution)
- Breakdown of API vs tool time

## 🎨 Visual Improvements

### Input Interface
```
┌────────────────────────────────────────────────┐
│ > Your message here                            │
└────────────────────────────────────────────────┘
```

### Session Summary Example
```
┌──────────────────────────────────────────────────────────────────┐
│ Interaction Summary                                              │
│Session ID:            2098a161-564f-45ca-9218-8c3c5c4a89b2     │
│Tool Calls:            5 ( ✓ 4 ✗ 1 )                            │
│Success Rate:          80.0%                                     │
│                                                                  │
│ Performance                                                      │
│Wall Time:             2m 15s                                    │
│Agent Active:          45s                                       │
│  » API Time:          30s (66.7%)                               │
│  » Tool Time:         15s (33.3%)                               │
└──────────────────────────────────────────────────────────────────┘
```

## 🔧 Technical Implementation

- **Session Tracking**: Comprehensive metrics collection
- **UUID Generation**: Unique session identifiers
- **Real-time Updates**: Live statistics during chat
- **Graceful Exits**: Proper cleanup and summary display
- **Error Handling**: Robust error tracking and reporting

## 💡 Tips

1. **Use `/stats`** to monitor session performance in real-time
2. **Check success rates** to identify potential issues
3. **Monitor timing** to understand performance bottlenecks
4. **Review tool breakdown** to see which tools are most used
5. **Use Ctrl+C** for quick exit with summary