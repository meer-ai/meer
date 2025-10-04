import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import type { Provider, ChatMessage } from '../providers/base.js';
import { readFile, listFiles, proposeEdit, applyEdit, generateDiff, parseToolCalls, type FileEdit } from '../tools/index.js';
import { memory } from '../memory/index.js';

export interface AgentConfig {
  provider: Provider;
  cwd: string;
  maxIterations?: number;
  enableMemory?: boolean;
  providerType?: string;
  model?: string;
}

interface TodoItem {
  task: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export class AgentWorkflow {
  private provider: Provider;
  private cwd: string;
  private maxIterations: number;
  private messages: ChatMessage[] = [];
  private proposedEdits: FileEdit[] = [];
  private todoList: TodoItem[] = [];
  private appliedEdits: Array<{ path: string; description: string; success: boolean }> = [];
  private enableMemory: boolean;
  private providerType: string;
  private model: string;

  constructor(config: AgentConfig) {
    this.provider = config.provider;
    this.cwd = config.cwd;
    this.maxIterations = config.maxIterations || 10;
    this.enableMemory = config.enableMemory ?? true;
    this.providerType = config.providerType || 'unknown';
    this.model = config.model || 'unknown';
  }

  /**
   * Initialize the agent with system prompt
   */
  initialize(contextPrompt: string) {
    this.messages = [
      {
        role: 'system',
        content: this.getSystemPrompt() + '\n\n' + contextPrompt
      }
    ];
  }

  /**
   * Process a user message with agentic workflow
   */
  async processMessage(userMessage: string): Promise<string> {
    // Add user message
    this.messages.push({ role: 'user', content: userMessage });

    // Save to memory if enabled
    if (this.enableMemory) {
      memory.addToSession({
        timestamp: Date.now(),
        role: 'user',
        content: userMessage
      });
    }

    console.log(chalk.green('\n🤖 AI Agent:\n'));

    let iteration = 0;
    let fullResponse = '';
    this.proposedEdits = [];
    const toolCallHistory: string[] = [];

    while (iteration < this.maxIterations) {
      iteration++;

      // Get AI response
      const spinner = ora(chalk.blue('Thinking...')).start();
      let response: string;
      try {
        response = await this.provider.chat(this.messages);
        spinner.stop();
      } catch (error) {
        spinner.stop();
        console.log(chalk.red('❌ Error:'), error instanceof Error ? error.message : String(error));
        console.log(chalk.yellow('\n⚠️  Failed to get response from AI provider'));
        console.log(chalk.gray('Please check your API key and configuration\n'));
        break;
      }

      fullResponse += response;

      // Parse tool calls from response
      const toolCalls = parseToolCalls(response);

      // If no tool calls, break the loop
      if (toolCalls.length === 0) {
        // Parse TODO list if present
        this.parseTodoList(response);

        // Show AI's final response
        console.log(this.formatResponse(response));
        this.messages.push({ role: 'assistant', content: response });

        // Save to memory if enabled
        if (this.enableMemory) {
          memory.addToSession({
            timestamp: Date.now(),
            role: 'assistant',
            content: response,
            metadata: {
              provider: this.providerType,
              model: this.model
            }
          });
        }

        break;
      }

      // Detect loops (same tool call repeated)
      const currentCallSig = toolCalls.map(t => `${t.tool}:${t.params.path || ''}`).join(',');
      if (toolCallHistory.includes(currentCallSig)) {
        console.log(chalk.yellow('\n⚠️  Detected repeated tool calls - stopping to prevent infinite loop'));
        console.log(chalk.gray('The AI seems stuck. Try rephrasing your request or providing more details.\n'));
        break;
      }
      toolCallHistory.push(currentCallSig);

      // Show AI's thinking
      const textBeforeTools = response.split('<tool')[0].trim();
      if (textBeforeTools) {
        console.log(chalk.cyan(textBeforeTools));
        console.log('');
      }

      // Execute tools
      const toolResults: string[] = [];

      for (const toolCall of toolCalls) {
        const result = await this.executeTool(toolCall);
        toolResults.push(result);
      }

      // Add tool results to conversation
      const toolResultsMessage = `Tool results:\n${toolResults.join('\n\n')}`;
      this.messages.push({ role: 'assistant', content: response });
      this.messages.push({ role: 'user', content: toolResultsMessage });
    }

    // If we have proposed edits, show them and ask for approval
    if (this.proposedEdits.length > 0) {
      await this.reviewEdits();

      // Show summary of all edits
      this.displayEditSummary();
    }

    return fullResponse;
  }

  /**
   * Execute a single tool call
   */
  private async executeTool(toolCall: { tool: string; params: Record<string, string>; content: string }): Promise<string> {
    const { tool, params, content } = toolCall;

    console.log(chalk.yellow(`🔧 Using tool: ${chalk.bold(tool)}`));

    switch (tool) {
      case 'read_file': {
        const filepath = params.path || params.file || params.filepath;
        if (!filepath) {
          console.log(chalk.red('  ❌ Missing required parameter: path'));
          return `Error: Missing path parameter`;
        }

        console.log(chalk.gray(`  📖 Reading: ${filepath}`));
        const result = readFile(filepath, this.cwd);

        if (result.error) {
          console.log(chalk.red(`  ❌ ${result.error}`));
          return `Error reading ${filepath}: ${result.error}`;
        }

        // Check if file doesn't exist (not an error, just info)
        if (result.result.includes('File not found')) {
          console.log(chalk.yellow(`  ℹ️  File doesn't exist yet - can be created with propose_edit`));
        } else {
          console.log(chalk.green(`  ✓ Read ${filepath}`));
        }

        return result.result;
      }

      case 'list_files': {
        const dirpath = params.path || params.dir || params.directory || '';
        console.log(chalk.gray(`  📂 Listing: ${dirpath || 'current directory'}`));
        const result = listFiles(dirpath, this.cwd);

        if (result.error) {
          console.log(chalk.red(`  ❌ ${result.error}`));
          return `Error listing ${dirpath}: ${result.error}`;
        }

        console.log(chalk.green(`  ✓ Listed ${dirpath || 'current directory'}`));
        return result.result;
      }

      case 'propose_edit': {
        const filepath = params.path || params.file || params.filepath;
        const description = params.description || 'Edit file';

        if (!filepath || !content) {
          console.log(chalk.red('  ❌ Missing required parameters: path and content'));
          return `Error: Missing path or content`;
        }

        console.log(chalk.gray(`  ✏️  Proposing edit: ${filepath}`));
        console.log(chalk.gray(`     ${description}`));

        const edit = proposeEdit(filepath, content, description, this.cwd);
        this.proposedEdits.push(edit);

        console.log(chalk.green(`  ✓ Edit proposed for ${filepath}`));
        return `Edit proposed for ${filepath}: ${description}`;
      }

      default:
        console.log(chalk.red(`  ❌ Unknown tool: ${tool}`));
        return `Error: Unknown tool ${tool}`;
    }
  }

  /**
   * Review and apply proposed edits
   */
  private async reviewEdits(): Promise<void> {
    console.log(chalk.bold.blue('\n\n📝 Proposed Changes:\n'));

    for (let i = 0; i < this.proposedEdits.length; i++) {
      const edit = this.proposedEdits[i];

      console.log(chalk.bold.yellow(`\n${i + 1}. ${edit.path}`));
      console.log(chalk.gray(`   ${edit.description}\n`));

      // Show diff
      const diff = generateDiff(edit.oldContent, edit.newContent);

      if (diff.length > 40) {
        console.log(chalk.gray('┌─ Changes (first 40 lines):'));
        diff.slice(0, 40).forEach(line => console.log(line));
        console.log(chalk.gray(`└─ ... and ${diff.length - 40} more lines\n`));
      } else if (diff.length > 0) {
        console.log(chalk.gray('┌─ Changes:'));
        diff.forEach(line => console.log(line));
        console.log(chalk.gray('└─\n'));
      } else {
        console.log(chalk.green('   No changes (new file)\n'));
        const lines = edit.newContent.split('\n');
        const preview = lines.slice(0, 10);
        console.log(chalk.gray('┌─ Preview:'));
        preview.forEach(line => console.log(chalk.gray(`│ ${line}`)));
        if (lines.length > 10) {
          console.log(chalk.gray(`│ ... (${lines.length - 10} more lines)`));
        }
        console.log(chalk.gray('└─\n'));
      }

      // Ask for approval
      const { action } = await inquirer.prompt([
        {
          type: 'list',
          name: 'action',
          message: `Apply changes to ${edit.path}?`,
          choices: [
            { name: 'Apply', value: 'apply' },
            { name: 'Skip', value: 'skip' },
            { name: 'Apply All Remaining', value: 'apply_all' },
            { name: 'Skip All Remaining', value: 'skip_all' }
          ],
          default: 'apply'
        }
      ]);

      if (action === 'apply') {
        const result = applyEdit(edit, this.cwd);
        const success = !result.error;

        this.appliedEdits.push({
          path: edit.path,
          description: edit.description,
          success
        });

        if (result.error) {
          console.log(chalk.red(`\n❌ ${result.error}\n`));
        } else {
          console.log(chalk.green(`\n✅ ${result.result}\n`));

          // Update TODO list if applicable
          this.updateTodoStatus(edit.path, 'completed');
        }
      } else if (action === 'skip') {
        console.log(chalk.gray('\nSkipped\n'));
        this.appliedEdits.push({
          path: edit.path,
          description: edit.description + ' (skipped)',
          success: false
        });
      } else if (action === 'apply_all') {
        // Apply this and all remaining
        for (let j = i; j < this.proposedEdits.length; j++) {
          const e = this.proposedEdits[j];
          const result = applyEdit(e, this.cwd);
          const success = !result.error;

          this.appliedEdits.push({
            path: e.path,
            description: e.description,
            success
          });

          if (result.error) {
            console.log(chalk.red(`❌ ${e.path}: ${result.error}`));
          } else {
            console.log(chalk.green(`✅ ${e.path}`));
            this.updateTodoStatus(e.path, 'completed');
          }
        }
        break;
      } else if (action === 'skip_all') {
        console.log(chalk.gray('\nSkipped all remaining changes\n'));

        // Mark all remaining as skipped
        for (let j = i; j < this.proposedEdits.length; j++) {
          this.appliedEdits.push({
            path: this.proposedEdits[j].path,
            description: this.proposedEdits[j].description + ' (skipped)',
            success: false
          });
        }
        break;
      }
    }
  }

  /**
   * Get system prompt for the agent
   */
  private getSystemPrompt(): string {
    return `You are an intelligent coding assistant with access to tools for reading files, listing directories, and proposing edits.

## Available Tools

1. **read_file** - Read the contents of a file
   Format: <tool name="read_file" path="path/to/file.ext"></tool>

2. **list_files** - List files and directories in a path
   Format: <tool name="list_files" path="path/to/directory"></tool>

3. **propose_edit** - Create or modify a file with new content
   Format: <tool name="propose_edit" path="path/to/file.ext" description="Brief description of changes">
   [Complete file content goes here]
   </tool>

## Critical Rules

1. **Tool Format**: Use XML-style tags exactly as shown above
2. **propose_edit Content**: Place the ENTIRE file content BETWEEN opening and closing tags, not in attributes
3. **No Self-Closing**: Never use <tool ... /> for propose_edit - always use <tool>...</tool>
4. **Complete Files**: Always provide the full file content in propose_edit, not just changes
5. **Explain First**: Always explain what you're doing before using tools

## Workflow Guidelines

1. **Understand the Request**: Read the user's question carefully
2. **Plan Your Approach**: For multi-step tasks, create a TODO list
3. **Explore First**: Use list_files and read_file to understand existing code
4. **Implement**: Use propose_edit with complete file content
5. **Explain**: Clearly communicate what you're doing at each step

## TODO Lists

For complex tasks, create a TODO list to track progress:

TODO:
- Understand the current implementation
- Identify files that need changes
- Implement the required functionality
- Test and verify the changes

The system will automatically display and update this list.

## File Operations

- **Reading**: Use read_file to examine existing files before modifying them
- **Creating**: Use propose_edit to create new files (no need to read first)
- **Modifying**: Read the file first, then use propose_edit with updated content
- **Non-existent Files**: If read_file returns "File not found", just create it with propose_edit

## Best Practices

- Be concise and focused in your explanations
- Only read files you actually need to see
- Keep TODO lists realistic and actionable
- Provide complete, working code in edits
- Don't make assumptions - ask for clarification if needed`;
  }

  /**
   * Format AI response for display (remove tool tags)
   */
  private formatResponse(response: string): string {
    // Remove tool tags for cleaner display
    return response.replace(/<tool[\s\S]*?<\/tool>/g, '').trim();
  }

  /**
   * Parse and display TODO list from AI response
   */
  private parseTodoList(response: string): void {
    // Look for TODO list in response (markdown format)
    const todoRegex = /(?:TODO|Tasks?|Steps?):\s*\n((?:[-*]\s+.+\n?)+)/gi;
    const match = todoRegex.exec(response);

    if (match) {
      const todoText = match[1];
      const lines = todoText.split('\n').filter(l => l.trim());

      this.todoList = lines.map(line => {
        const task = line.replace(/^[-*]\s+/, '').trim();
        return { task, status: 'pending' as const };
      });

      if (this.todoList.length > 0) {
        this.displayTodoList();
      }
    }
  }

  /**
   * Display the TODO list
   */
  private displayTodoList(): void {
    console.log(chalk.bold.blue('\n📋 Task List:\n'));

    this.todoList.forEach((item, index) => {
      const icon = item.status === 'completed' ? chalk.green('✅') :
                   item.status === 'in_progress' ? chalk.yellow('⏳') :
                   chalk.gray('⬜');

      const text = item.status === 'completed' ? chalk.gray(item.task) :
                   item.status === 'in_progress' ? chalk.cyan(item.task) :
                   item.task;

      console.log(`${icon} ${index + 1}. ${text}`);
    });

    console.log('');
  }

  /**
   * Update TODO item status
   */
  private updateTodoStatus(taskPattern: string, status: 'in_progress' | 'completed'): void {
    const item = this.todoList.find(t =>
      t.task.toLowerCase().includes(taskPattern.toLowerCase())
    );

    if (item) {
      item.status = status;
      this.displayTodoList();
    }
  }

  /**
   * Display summary of all applied edits
   */
  private displayEditSummary(): void {
    if (this.appliedEdits.length === 0) return;

    console.log(chalk.bold.blue('\n📊 Summary of Changes:\n'));

    const successful = this.appliedEdits.filter(e => e.success);
    const failed = this.appliedEdits.filter(e => !e.success);

    if (successful.length > 0) {
      console.log(chalk.green(`✅ Successfully updated ${successful.length} file(s):\n`));
      successful.forEach(edit => {
        console.log(chalk.green(`  • ${edit.path}`) + chalk.gray(` - ${edit.description}`));
      });
      console.log('');
    }

    if (failed.length > 0) {
      console.log(chalk.red(`❌ Failed to update ${failed.length} file(s):\n`));
      failed.forEach(edit => {
        console.log(chalk.red(`  • ${edit.path}`) + chalk.gray(` - ${edit.description}`));
      });
      console.log('');
    }

    console.log(chalk.gray('──────────────────────────────────────────'));
    console.log(chalk.bold(`Total: ${this.appliedEdits.length} change(s)`));
    console.log('');
  }
}