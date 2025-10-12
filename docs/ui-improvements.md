# UI Improvements for MeerAI

This document describes the terminal UI enhancements available in MeerAI.

## Available UI Modules

### 1. `src/ui/formatter.ts`
Provides rich terminal formatting utilities.

#### Functions:

**Format Markdown**
```typescript
import { formatMarkdown } from "./ui/formatter.js";

const formatted = formatMarkdown("# Hello\n\nThis is **bold** and `code`.");
console.log(formatted);
```

**Create Pretty Boxes**
```typescript
import { createBox } from "./ui/formatter.js";

// Success box
console.log(createBox("Build completed successfully!", {
  title: "Success",
  type: "success"
}));

// Error box
console.log(createBox("Build failed with 5 errors", {
  title: "Error",
  type: "error"
}));

// Warning box
console.log(createBox("Deprecated API usage detected", {
  title: "Warning",
  type: "warning"
}));

// Info box
console.log(createBox("Starting build process...", {
  title: "Info",
  type: "info"
}));
```

**Create Tables**
```typescript
import { createTable } from "./ui/formatter.js";

const table = createTable(
  ["File", "Status", "Time"],
  [
    ["index.ts", "✓ Pass", "1.2s"],
    ["app.ts", "✗ Fail", "0.8s"],
    ["utils.ts", "✓ Pass", "0.5s"],
  ]
);

console.log(table);
```

**Format Code Blocks with Syntax Highlighting**
```typescript
import { formatCodeBlock } from "./ui/formatter.js";

const code = `
function hello() {
  console.log("Hello, world!");
}
`;

console.log(formatCodeBlock(code, "javascript"));
```

**Format Lists**
```typescript
import { formatList } from "./ui/formatter.js";

// Unordered list
console.log(formatList([
  "Install dependencies",
  "Run build",
  "Run tests"
]));

// Ordered list
console.log(formatList([
  "Clone repository",
  "Install dependencies",
  "Start development"
], { ordered: true }));
```

**Format Messages**
```typescript
import { formatError, formatSuccess, formatWarning, formatInfo } from "./ui/formatter.js";

console.log(formatError("File not found", "src/index.ts"));
console.log(formatSuccess("All tests passed"));
console.log(formatWarning("API rate limit approaching"));
console.log(formatInfo("Starting application..."));
```

**Create Sections**
```typescript
import { createSection } from "./ui/formatter.js";

console.log(createSection("Build Results", "5 files compiled successfully"));
```

**Format Validation Results**
```typescript
import { formatValidationResults } from "./ui/formatter.js";

const results = [
  { name: "TypeScript", status: "passed" as const },
  { name: "ESLint", status: "failed" as const, message: "2 errors found" },
  { name: "Tests", status: "skipped" as const, message: "No test script" }
];

console.log(formatValidationResults(results));
```

### 2. `src/ui/response-formatter.ts`
Handles streaming response formatting.

#### Features:
- Real-time markdown rendering for streamed responses
- Automatic code block detection and syntax highlighting
- Inline formatting (bold, italic, code)
- Header formatting
- List formatting

**Usage Example:**
```typescript
import { ResponseFormatter } from "./ui/response-formatter.js";

const formatter = new ResponseFormatter();

// Process chunks as they arrive
for (const chunk of streamingResponse) {
  const formatted = formatter.processChunk(chunk);
  if (formatted) {
    process.stdout.write(formatted);
  }
}

// Flush remaining content
const final = formatter.flush();
if (final) {
  process.stdout.write(final);
}
```

## Implementation Examples

### In Tools (tools/index.ts)

You can use these formatters in tool outputs:

```typescript
import { formatError, formatSuccess, createTable } from "../ui/formatter.js";

export function someToolFunction(cwd: string): ToolResult {
  try {
    // ... do work ...

    return {
      tool: "some_tool",
      result: formatSuccess("Operation completed successfully!")
    };
  } catch (error) {
    return {
      tool: "some_tool",
      result: "",
      error: formatError(error.message, "someToolFunction")
    };
  }
}
```

### In Workflow (agent/workflow-v2.ts)

The response formatter can be integrated into the streaming response:

```typescript
import { ResponseFormatter } from "../ui/response-formatter.js";

// In processMessage method:
const formatter = new ResponseFormatter();

for await (const chunk of this.provider.stream(this.messages)) {
  const formatted = formatter.processChunk(chunk);
  if (formatted) {
    process.stdout.write(formatted);
    response += chunk; // Keep original for parsing
  }
}
```

## Benefits

1. **Better Readability**: Syntax-highlighted code blocks are easier to read
2. **Visual Hierarchy**: Headers, sections, and boxes create clear structure
3. **Status Indicators**: Color-coded success/error/warning messages
4. **Professional Output**: Tables and boxes make output look polished
5. **Real-time Enhancement**: Streaming responses get formatted as they arrive

## Future Enhancements

- Interactive prompts with better styling
- Progress bars for long-running operations
- Animated spinners with more context
- File tree visualization
- Diff viewer enhancements
- Chart/graph rendering for metrics

## Dependencies

- `marked` - Markdown parsing
- `marked-terminal` - Terminal markdown renderer
- `cli-highlight` - Syntax highlighting
- `boxen` - Pretty boxes
- `cli-table3` - Table formatting
- `chalk` - Terminal colors (already in use)
