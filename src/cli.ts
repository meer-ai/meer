import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { createAskCommand } from './commands/ask.js';
import { createChatCommand } from './commands/chat.js';
import { createCommitMsgCommand } from './commands/commitMsg.js';
import { createReviewCommand } from './commands/review.js';
import { createMemoryCommand } from './commands/memory.js';
import { createSetupCommand } from './commands/setup.js';

async function showWelcomeScreen() {
  console.clear();

  // Meerai ASCII art logo with wave
  console.log(chalk.hex('#00B4D8')('        ╔╦╗╔═╗╔═╗╦═╗   ') + chalk.hex('#0077B6')('  ~~~~'));
  console.log(chalk.hex('#0096C7')('        ║║║║╣ ║╣ ╠╦╝   ') + chalk.hex('#00B4D8')(' ~~~~~'));
  console.log(chalk.hex('#0077B6')('        ╩ ╩╚═╝╚═╝╩╚═   ') + chalk.hex('#48CAE4')('~~~~~~'));
  console.log('');
  console.log(chalk.bold.cyan('🌊 Your AI companion that flows like the sea'));
  console.log(chalk.gray('Model-agnostic CLI supporting Ollama, OpenAI, and Gemini'));
  console.log('');

  // Check if this is first-time setup
  const { configExists } = await import('./config.js');
  if (!configExists()) {
    console.log(chalk.yellow('👋 Welcome! It looks like this is your first time using MeerAI.\n'));

    const { runSetup } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'runSetup',
        message: 'Would you like to run the setup wizard?',
        default: true
      }
    ]);

    if (runSetup) {
      const { createSetupCommand } = await import('./commands/setup.js');
      const setupCmd = createSetupCommand();
      await setupCmd.parseAsync(['setup'], { from: 'user' });
      console.log('');
    } else {
      console.log(chalk.gray('\nSkipping setup. A default configuration will be created.'));
      console.log(chalk.yellow('💡 Tip: Run ') + chalk.cyan('meer setup') + chalk.yellow(' anytime to configure MeerAI.\n'));
    }
  }

  // Load and display config details
  try {
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();

    const providerLabel = config.providerType === 'ollama' ? '🦙 Ollama' :
                          config.providerType === 'openai' ? '🤖 OpenAI' :
                          config.providerType === 'gemini' ? '✨ Gemini' : config.providerType;

    console.log(chalk.bold.blue('📋 Configuration:'));
    console.log(chalk.white('  Provider:') + ' ' + chalk.yellow(providerLabel));
    console.log(chalk.white('  Model:') + ' ' + chalk.green(config.model));
    console.log(chalk.white('  Version:') + ' ' + chalk.gray('1.0.0'));
    console.log('');
  } catch (error) {
    console.log(chalk.yellow('⚠️  Configuration not loaded'));
    console.log('');
  }
  
  console.log(chalk.bold.yellow('🚀 Quick Commands:'));
  console.log(chalk.white('• Setup wizard:') + ' ' + chalk.cyan('meer setup'));
  console.log(chalk.white('• Ask questions:') + ' ' + chalk.cyan('meer ask "What does this code do?"'));
  console.log(chalk.white('• Interactive chat:') + ' ' + chalk.cyan('meer chat'));
  console.log(chalk.white('• Generate commits:') + ' ' + chalk.cyan('meer commit-msg'));
  console.log(chalk.white('• Code review:') + ' ' + chalk.cyan('meer review'));
  console.log(chalk.white('• View memory:') + ' ' + chalk.cyan('meer memory'));
  console.log('');
  
  console.log(chalk.bold.magenta('⚡ Slash Commands:'));
  console.log(chalk.white('• /init') + ' ' + chalk.gray('- Create AGENTS.md for project tracking'));
  console.log(chalk.white('• /provider') + ' ' + chalk.gray('- Switch AI provider'));
  console.log(chalk.white('• /model') + ' ' + chalk.gray('- Switch AI model'));
  console.log(chalk.white('• /help') + ' ' + chalk.gray('- Show detailed help'));
  console.log(chalk.white('• /exit') + ' ' + chalk.gray('- Exit chat session'));
  console.log('');
  console.log(chalk.gray('─────────────────────────────────────────'));
  console.log('');
  console.log(chalk.bold.green('Starting interactive chat...'));
  console.log(chalk.gray('Type your messages below. Type "exit" or "quit" to end the session.'));
  console.log(chalk.gray('Type "/" to see available slash commands.'));
  console.log('');
}

async function handleSlashCommand(command: string, config: any) {
  const [cmd, ...args] = command.split(' ');

  switch (cmd) {
    case '/init':
      await handleInitCommand();
      return 'continue'; // Continue chat session

    case '/help':
      showSlashHelp();
      return 'continue'; // Continue chat session

    case '/model':
      await handleModelCommand(config);
      return 'continue'; // Continue chat session

    case '/provider':
      await handleProviderCommand();
      return 'restart'; // Need to restart to load new provider

    case '/exit':
      console.log(chalk.gray('Exiting chat session...'));
      return 'exit'; // Exit the chat loop

    default:
      console.log(chalk.red(`Unknown command: ${cmd}`));
      console.log(chalk.gray('Type /help for available commands'));
      return 'continue'; // Continue chat session
  }
}

async function handleInitCommand() {
  const { writeFileSync, existsSync } = await import('fs');
  const { join } = await import('path');
  
  const agentsContent = `# AI Agent Configuration

This file helps AI models understand your project structure and coding preferences.

## Project Overview
- **Name**: ${process.cwd().split('/').pop() || 'My Project'}
- **Type**: [Describe your project type]
- **Tech Stack**: [List main technologies]

## Coding Standards
- **Language**: TypeScript/JavaScript
- **Style**: [Your preferred coding style]
- **Patterns**: [Architectural patterns you use]

## Key Directories
- \`src/\` - Source code
- \`tests/\` - Test files
- \`docs/\` - Documentation

## Important Files
- \`package.json\` - Dependencies and scripts
- \`tsconfig.json\` - TypeScript configuration
- \`README.md\` - Project documentation

## AI Instructions
When working with this codebase:
1. Follow existing code patterns
2. Maintain type safety with TypeScript
3. Write clear, self-documenting code
4. Include appropriate error handling
5. Follow the established project structure

## Recent Changes
- [Track important changes here]

---
*This file is automatically managed by DevAI CLI*
`;

  const agentsPath = join(process.cwd(), 'AGENTS.md');
  
  if (existsSync(agentsPath)) {
    console.log(chalk.yellow('⚠️  AGENTS.md already exists'));
    console.log(chalk.gray('Use /help for other commands'));
    return;
  }
  
  try {
    writeFileSync(agentsPath, agentsContent);
    console.log(chalk.green('✅ Created AGENTS.md'));
    console.log(chalk.gray('This file helps AI understand your project better'));
    console.log(chalk.cyan('Edit it to customize AI behavior for your project'));
  } catch (error) {
    console.log(chalk.red('❌ Failed to create AGENTS.md:'), error);
  }
}

async function handleModelCommand(config: any) {
  try {
    const provider = config.provider;

    // Check if provider supports model listing
    if (provider.listModels && typeof provider.listModels === 'function') {
      const spinner = ora(chalk.blue('Fetching available models...')).start();

      try {
        const models = await provider.listModels();
        spinner.stop();

        if (models.length === 0) {
          console.log(chalk.yellow('⚠️  No models found'));
          return;
        }

        const currentModel = provider.getCurrentModel ? provider.getCurrentModel() : config.name;

        console.log(chalk.bold.blue('\n📦 Available Models:\n'));

        const choices = models.map((model: any) => {
          const displayName = model.name || model;
          const modelId = model.id || model.name || model;
          const isCurrent = modelId === currentModel;
          const label = isCurrent ? `${displayName} ${chalk.green('(current)')}` : displayName;

          return {
            name: label,
            value: modelId
          };
        });

        const { selectedModel } = await inquirer.prompt([
          {
            type: 'list',
            name: 'selectedModel',
            message: 'Select a model:',
            choices: [
              ...choices,
              new inquirer.Separator(),
              { name: chalk.gray('Cancel'), value: null }
            ]
          }
        ]);

        if (selectedModel && selectedModel !== currentModel) {
          if (provider.switchModel && typeof provider.switchModel === 'function') {
            provider.switchModel(selectedModel);
            console.log(chalk.green(`\n✅ Switched to model: ${chalk.bold(selectedModel)}\n`));

            // Update config file
            const { writeFileSync, readFileSync, existsSync } = await import('fs');
            const { join } = await import('path');
            const { homedir } = await import('os');
            const configPath = join(homedir(), '.meer', 'config.yaml');

            const yaml = await import('yaml');

            if (existsSync(configPath)) {
              const content = readFileSync(configPath, 'utf-8');
              const fullConfig = yaml.parse(content);

              // Update the model in config
              fullConfig.model = selectedModel;

              writeFileSync(configPath, yaml.stringify(fullConfig), 'utf-8');
              console.log(chalk.gray('Configuration updated in config.yaml\n'));
            } else {
              console.log(chalk.yellow('⚠️  Config file not found, model changed for this session only\n'));
            }
          } else {
            console.log(chalk.yellow('⚠️  Provider does not support model switching'));
          }
        } else if (selectedModel === currentModel) {
          console.log(chalk.gray('\nNo change - already using this model\n'));
        } else {
          console.log(chalk.gray('\nCancelled\n'));
        }
      } catch (error) {
        spinner.stop();
        console.log(chalk.red('❌ Failed to fetch models:'), error instanceof Error ? error.message : String(error));
      }
    } else {
      console.log(chalk.yellow('⚠️  Current provider does not support model listing'));
      console.log(chalk.gray('Available for: Ollama, OpenAI-compatible providers'));
    }
  } catch (error) {
    console.log(chalk.red('❌ Error:'), error instanceof Error ? error.message : String(error));
  }
}

async function handleProviderCommand() {
  try {
    const { readFileSync, writeFileSync, existsSync } = await import('fs');
    const { join } = await import('path');
    const { homedir } = await import('os');
    const configPath = join(homedir(), '.meer', 'config.yaml');

    if (!existsSync(configPath)) {
      console.log(chalk.red('❌ Config file not found'));
      return;
    }

    const yaml = await import('yaml');
    const content = readFileSync(configPath, 'utf-8');
    const config = yaml.parse(content);

    const currentProvider = config.provider || 'ollama';

    const providers = [
      { name: 'ollama', icon: '🦙', label: 'Ollama (Local)' },
      { name: 'openai', icon: '🤖', label: 'OpenAI' },
      { name: 'gemini', icon: '✨', label: 'Google Gemini' }
    ];

    console.log(chalk.bold.blue('\n🔌 Available Providers:\n'));

    const choices = providers.map(p => {
      const label = p.name === currentProvider
        ? `${p.icon} ${p.label} ${chalk.green('(current)')}`
        : `${p.icon} ${p.label}`;

      return {
        name: label,
        value: p.name
      };
    });

    const { selectedProvider } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selectedProvider',
        message: 'Select a provider:',
        choices: [
          ...choices,
          new inquirer.Separator(),
          { name: chalk.gray('Cancel'), value: null }
        ]
      }
    ]);

    if (selectedProvider && selectedProvider !== currentProvider) {
      config.provider = selectedProvider;

      // Set default model based on provider if not already set
      if (!config.model || config.provider !== selectedProvider) {
        if (selectedProvider === 'openai') {
          config.model = 'gpt-4o';
        } else if (selectedProvider === 'gemini') {
          config.model = 'gemini-2.0-flash-exp';
        } else if (selectedProvider === 'ollama') {
          config.model = 'mistral:7b-instruct';
        }
      }

      writeFileSync(configPath, yaml.stringify(config), 'utf-8');

      const selected = providers.find(p => p.name === selectedProvider);
      console.log(chalk.green(`\n✅ Switched to provider: ${chalk.bold(selected?.label)}`));
      console.log(chalk.gray(`   Default model: ${config.model}`));
      console.log(chalk.yellow('\n⚠️  Please restart the CLI for changes to take effect\n'));
      console.log(chalk.gray(`💡 Tip: Use ${chalk.cyan('/model')} to change the model after restart\n`));
    } else if (selectedProvider === currentProvider) {
      console.log(chalk.gray('\nNo change - already using this provider\n'));
    } else {
      console.log(chalk.gray('\nCancelled\n'));
    }
  } catch (error) {
    console.log(chalk.red('❌ Error:'), error instanceof Error ? error.message : String(error));
  }
}

function showSlashHelp() {
  console.log(chalk.bold.blue('\n📚 Available Slash Commands:\n'));
  console.log(chalk.cyan('/init') + ' ' + chalk.gray('- Create AGENTS.md for project tracking'));
  console.log(chalk.cyan('/provider') + ' ' + chalk.gray('- Switch AI provider (Ollama, OpenAI, Gemini)'));
  console.log(chalk.cyan('/model') + ' ' + chalk.gray('- Switch AI model'));
  console.log(chalk.cyan('/help') + ' ' + chalk.gray('- Show this help message'));
  console.log(chalk.cyan('/exit') + ' ' + chalk.gray('- Exit chat session'));
  console.log('');
  console.log(chalk.gray('💡 Tip: Use /provider to switch between Ollama, OpenAI, and Gemini'));
}

async function handleCodeBlocks(aiResponse: string) {
  const { writeFileSync, existsSync, mkdirSync, readFileSync } = await import('fs');
  const { join, dirname } = await import('path');

  // Look for code blocks in the AI response
  const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
  const matches = [...aiResponse.matchAll(codeBlockRegex)];

  if (matches.length === 0) {
    return; // No code blocks found
  }

  // Check if always allow is enabled
  const alwaysAllow = process.env.DEVAI_ALWAYS_ALLOW === 'true';

  console.log(chalk.bold.blue('\n📝 Creating/updating files from AI response...\n'));

  for (const match of matches) {
    const [, language, code] = match;
    let cleanCode = code.trim();

    // Try to extract filepath from comment at the top of the code block
    let filename = '';
    let filePath = '';
    const filepathMatch = cleanCode.match(/^(?:\/\/|#|<!--)\s*filepath:\s*(.+?)(?:-->)?\n/i);

    if (filepathMatch) {
      // Extract filepath from comment
      filename = filepathMatch[1].trim();
      // Remove the filepath comment from the code
      cleanCode = cleanCode.replace(/^(?:\/\/|#|<!--)\s*filepath:\s*.+?(?:-->)?\n/i, '').trim();

      // Check if it's an absolute path
      const { isAbsolute } = await import('path');
      if (isAbsolute(filename)) {
        filePath = filename;
      } else {
        filePath = join(process.cwd(), filename);
      }
    } else {
      // Fallback: Determine file extension and name based on language
      if (language === 'html') {
        filename = 'index.html';
      } else if (language === 'javascript' || language === 'js') {
        filename = 'app.js';
      } else if (language === 'css') {
        filename = 'style.css';
      } else if (language === 'python' || language === 'py') {
        filename = 'main.py';
      } else if (language === 'typescript' || language === 'ts') {
        filename = 'index.ts';
      } else if (language === 'json') {
        filename = 'config.json';
      } else {
        // Default to .txt for unknown languages
        filename = `code_${Date.now()}.txt`;
      }
      filePath = join(process.cwd(), filename);
    }
    
    // Check if file already exists
    const fileExists = existsSync(filePath);
    let existingContent = '';
    if (fileExists) {
      try {
        existingContent = readFileSync(filePath, 'utf-8');
      } catch (error) {
        existingContent = '';
      }
    }
    
    // Get display name (basename for absolute paths)
    const { basename } = await import('path');
    const displayName = basename(filePath);

    // Show file analysis and diff
    if (fileExists && existingContent !== cleanCode) {
      console.log(chalk.yellow(`📄 Updating existing file: ${filePath}`));
      showColoredDiff(existingContent, cleanCode);
    } else if (!fileExists) {
      console.log(chalk.green(`📄 Creating new file: ${filePath}`));
      showFilePreview(cleanCode);
    } else {
      console.log(chalk.gray(`📄 File ${filePath} unchanged`));
      continue;
    }

    // Quick confirmation for non-always-allow mode
    let action = 'apply';
    if (!alwaysAllow) {
      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: `Apply changes to ${filePath}?`,
          default: true
        }
      ]);

      if (!confirm) {
        console.log(chalk.gray(`Skipped ${filePath}`));
        continue;
      }
    }

    // Apply changes
    try {
      // Ensure directory exists
      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(filePath, cleanCode, 'utf-8');
      console.log(chalk.green(`✅ Created/updated: ${filePath}`));
    } catch (error) {
      console.log(chalk.red(`❌ Failed to create ${filePath}:`), error);
    }
  }
  
  console.log(chalk.gray('\n💡 Files are ready to use!'));
}

function showColoredDiff(oldContent: string, newContent: string) {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  
  console.log(chalk.gray('┌─ Changes:'));
  
  // Show first few lines of changes
  let changeCount = 0;
  const maxChanges = 8;
  
  for (let i = 0; i < Math.max(oldLines.length, newLines.length) && changeCount < maxChanges; i++) {
    const oldLine = oldLines[i] || '';
    const newLine = newLines[i] || '';
    
    if (oldLine !== newLine) {
      changeCount++;
      if (oldLine) {
        console.log(chalk.red(`- ${oldLine}`));
      }
      if (newLine) {
        console.log(chalk.green(`+ ${newLine}`));
      }
    } else if (changeCount > 0 && changeCount < 3) {
      // Show context lines
      console.log(chalk.gray(`  ${oldLine}`));
    }
  }
  
  if (changeCount >= maxChanges) {
    console.log(chalk.gray('  ... (more changes)'));
  }
  
  console.log(chalk.gray('└─'));
}

function showFilePreview(content: string) {
  const lines = content.split('\n');
  const previewLines = lines.slice(0, 5);
  
  console.log(chalk.gray('┌─ Preview:'));
  previewLines.forEach(line => {
    console.log(chalk.gray(`│ ${line}`));
  });
  
  if (lines.length > 5) {
    console.log(chalk.gray(`│ ... (${lines.length - 5} more lines)`));
  }
  
  console.log(chalk.gray('└─'));
}

async function collectProjectContext() {
  const { readFileSync, existsSync, readdirSync, statSync } = await import('fs');
  const { join, extname } = await import('path');

  const cwd = process.cwd();
  const contextFiles: Array<{ name: string; content: string; path: string }> = [];

  // Patterns to include
  const includePatterns = [
    '*.html', '*.css', '*.js', '*.ts', '*.jsx', '*.tsx', '*.json',
    '*.py', '*.java', '*.go', '*.rs', '*.md', 'README*', 'package.json',
    'tsconfig.json', 'AGENTS.md', '*.yml', '*.yaml'
  ];

  // Directories to ignore
  const ignoreDirs = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '__pycache__'];

  function scanDirectory(dir: string, depth: number = 0): void {
    if (depth > 2) return; // Limit depth to avoid deep recursion

    try {
      const items = readdirSync(dir);

      for (const item of items) {
        const fullPath = join(dir, item);

        try {
          const stats = statSync(fullPath);

          if (stats.isDirectory()) {
            if (!ignoreDirs.includes(item) && !item.startsWith('.')) {
              scanDirectory(fullPath, depth + 1);
            }
          } else if (stats.isFile()) {
            const ext = extname(item);
            const shouldInclude = includePatterns.some(pattern => {
              if (pattern.startsWith('*')) {
                return item.endsWith(pattern.slice(1));
              }
              return item === pattern || item.startsWith(pattern);
            });

            if (shouldInclude && stats.size < 100000) { // Max 100KB per file
              try {
                const content = readFileSync(fullPath, 'utf-8');
                const relativePath = fullPath.replace(cwd, '').replace(/\\/g, '/').replace(/^\//, '');
                contextFiles.push({ name: item, content, path: relativePath });
              } catch (error) {
                // Skip files that can't be read
              }
            }
          }
        } catch (error) {
          // Skip items that can't be accessed
        }
      }
    } catch (error) {
      // Skip directories that can't be read
    }
  }

  scanDirectory(cwd);

  return contextFiles;
}

async function buildContextPrompt(contextFiles: Array<{ name: string; content: string; path: string }>) {
  let contextPrompt = 'You are an AI coding assistant with access to the user\'s project files. ';
  contextPrompt += 'When the user asks you to modify or improve code, you should:\n';
  contextPrompt += '1. Analyze the existing files to understand the project structure\n';
  contextPrompt += '2. Identify which files need to be modified or created\n';
  contextPrompt += '3. Provide complete, updated code in code blocks with the filename as a comment at the top\n';
  contextPrompt += '4. Use this format for file modifications:\n';
  contextPrompt += '```language\n// filepath: path/to/file.ext\ncode here\n```\n\n';

  if (contextFiles.length > 0) {
    contextPrompt += '## Current Project Files:\n\n';

    for (const file of contextFiles.slice(0, 20)) { // Limit to 20 files
      contextPrompt += `### ${file.path}\n`;
      contextPrompt += '```\n';
      const lines = file.content.split('\n');
      if (lines.length > 50) {
        contextPrompt += lines.slice(0, 30).join('\n');
        contextPrompt += `\n... (${lines.length - 30} more lines)\n`;
      } else {
        contextPrompt += file.content;
      }
      contextPrompt += '\n```\n\n';
    }

    if (contextFiles.length > 20) {
      contextPrompt += `\n... and ${contextFiles.length - 20} more files\n\n`;
    }
  }

  return contextPrompt;
}

async function showFileAnalysis() {
  const { readFileSync, existsSync, statSync } = await import('fs');
  const { join } = await import('path');

  // Common file patterns to analyze
  const filePatterns = [
    'index.html', 'app.js', 'style.css', 'main.py', 'index.ts', 'config.json'
  ];

  const analysisFiles = [];

  for (const pattern of filePatterns) {
    const filePath = join(process.cwd(), pattern);
    if (existsSync(filePath)) {
      const stats = statSync(filePath);
      const content = readFileSync(filePath, 'utf-8');
      analysisFiles.push({ name: pattern, size: stats.size, content });
    }
  }

  if (analysisFiles.length > 0) {
    console.log(chalk.bold.blue('\n📊 File Analysis:\n'));

    for (const file of analysisFiles) {
      console.log(chalk.cyan(`📄 ${file.name}`));
      console.log(chalk.gray(`   Size: ${file.size} bytes`));
      console.log(chalk.gray(`   Lines: ${file.content.split('\n').length}`));

      // Show file type analysis
      if (file.name.endsWith('.html')) {
        const hasScript = file.content.includes('<script');
        const hasStyle = file.content.includes('<style');
        console.log(chalk.gray(`   Features: ${hasScript ? 'JavaScript' : ''} ${hasStyle ? 'CSS' : ''}`));
      } else if (file.name.endsWith('.js')) {
        const functions = (file.content.match(/function\s+\w+/g) || []).length;
        const classes = (file.content.match(/class\s+\w+/g) || []).length;
        console.log(chalk.gray(`   Features: ${functions} functions, ${classes} classes`));
      } else if (file.name.endsWith('.py')) {
        const functions = (file.content.match(/def\s+\w+/g) || []).length;
        const classes = (file.content.match(/class\s+\w+/g) || []).length;
        console.log(chalk.gray(`   Features: ${functions} functions, ${classes} classes`));
      }

      console.log('');
    }

    console.log(chalk.gray('💡 Files are ready to run or open in your editor!'));
  }
}

export function createCLI(): Command {
  const program = new Command();

  program
    .name('meer')
    .description('MeerAI - Dive deep into your code. An open-source, local-first AI CLI for developers.')
    .version('1.0.0')
    .option('-p, --profile <name>', 'Override the active profile')
    .hook('preAction', (thisCommand) => {
      const options = thisCommand.opts();
      if (options.profile) {
        process.env.DEVAI_PROFILE = options.profile;
      }
    });
  
  // Add commands
  program.addCommand(createSetupCommand());
  program.addCommand(createAskCommand());
  program.addCommand(createChatCommand());
  program.addCommand(createCommitMsgCommand());
  program.addCommand(createReviewCommand());
  program.addCommand(createMemoryCommand());
  
        // Show welcome screen and start chat when no command is provided
        program.action(async () => {
          await showWelcomeScreen();

          // Import and start the chat functionality
          const { createInterface } = await import('readline');
          const { loadConfig } = await import('./config.js');

          try {
            const config = loadConfig();

            // Initialize agent workflow
            const { AgentWorkflow } = await import('./agent/workflow.js');
            const agent = new AgentWorkflow({
              provider: config.provider,
              cwd: process.cwd(),
              maxIterations: 10
            });

            // Collect lightweight context (just file list, not full contents)
            console.log(chalk.gray('📂 Scanning project...'));
            const contextFiles = await collectProjectContext();
            console.log(chalk.gray(`✓ Found ${contextFiles.length} relevant files\n`));

            // Build minimal context prompt (just file list)
            const fileList = contextFiles.map(f => `- ${f.path}`).join('\n');
            const contextPrompt = `## Available Files in Project:\n\n${fileList}\n\nUse the read_file tool to read any files you need.`;

            // Initialize agent
            agent.initialize(contextPrompt);

            const askQuestion = async (): Promise<string> => {
              return new Promise((resolve) => {
                let input = '';
                let cursorPos = 0;

                // Set raw mode for character-by-character input
                if (process.stdin.setRawMode) {
                  process.stdin.setRawMode(true);
                }
                process.stdin.resume();

                process.stdout.write(chalk.cyan('You: '));

                const cleanup = () => {
                  process.stdin.removeListener('data', onData);
                  if (process.stdin.setRawMode) {
                    process.stdin.setRawMode(false);
                  }
                };

                const onData = (buffer: Buffer) => {
                  const char = buffer.toString();
                  const charCode = buffer[0];

                  // Handle Ctrl+C
                  if (charCode === 3) {
                    cleanup();
                    process.stdout.write('\n');
                    process.exit(0);
                  }

                  // Handle Enter
                  if (char === '\r' || char === '\n') {
                    cleanup();
                    process.stdout.write('\n');

                    // If user typed just "/" or starts with "/", show command list
                    if (input.trim() === '/') {
                      inquirer.prompt({
                        type: 'rawlist',
                        name: 'command',
                        message: 'Select a slash command (use number or arrow keys):',
                        choices: [
                          { name: '/init - Create AGENTS.md for project tracking', value: '/init' },
                          { name: '/provider - Switch AI provider', value: '/provider' },
                          { name: '/model - Switch AI model', value: '/model' },
                          { name: '/help - Show detailed help', value: '/help' },
                          { name: '/exit - Exit chat session', value: '/exit' }
                        ]
                      }).then((result) => {
                        resolve(result.command);
                      }).catch(() => {
                        resolve('');
                      });
                    } else {
                      resolve(input.trim());
                    }
                    return;
                  }

                  // Handle Backspace/Delete
                  if (charCode === 127 || charCode === 8) {
                    if (input.length > 0) {
                      input = input.slice(0, -1);
                      process.stdout.write('\b \b');
                    }
                    return;
                  }

                  // Handle "/" key - immediately show dropdown
                  if (char === '/' && input.length === 0) {
                    cleanup();
                    process.stdout.write('/\n');

                    inquirer.prompt({
                      type: 'rawlist',
                      name: 'command',
                      message: 'Select a slash command (use number or arrow keys):',
                      choices: [
                        { name: '/init - Create AGENTS.md for project tracking', value: '/init' },
                        { name: '/provider - Switch AI provider', value: '/provider' },
                        { name: '/model - Switch AI model', value: '/model' },
                        { name: '/help - Show detailed help', value: '/help' },
                        { name: '/exit - Exit chat session', value: '/exit' }
                      ]
                    }).then((result) => {
                      resolve(result.command);
                    }).catch(() => {
                      resolve('');
                    });
                    return;
                  }

                  // Regular printable characters
                  if (charCode >= 32 && charCode <= 126) {
                    input += char;
                    process.stdout.write(char);
                  }
                };

                process.stdin.on('data', onData);
              });
            };


      while (true) {
        const userInput = await askQuestion();

        if (userInput.toLowerCase() === 'exit' || userInput.toLowerCase() === 'quit') {
          break;
        }

        if (!userInput) {
          continue;
        }

        // Handle slash commands
        if (userInput.startsWith('/')) {
          const result = await handleSlashCommand(userInput, config);
          if (result === 'exit') {
            break; // Exit the chat loop
          }
          // Continue the chat loop after slash command execution
          console.log(''); // Add spacing
          continue;
        }

        // Process user message with agent workflow
        try {
          await agent.processMessage(userInput);
        } catch (error) {
          console.log(chalk.red('\n❌ Error:'), error instanceof Error ? error.message : String(error));
        }

        console.log('\n');
      }

      console.log(chalk.gray('\nChat session ended.'));

    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
  
  // Global error handling
  program.configureOutput({
    writeErr: (str) => process.stderr.write(str),
    writeOut: (str) => process.stdout.write(str),
    outputError: (str, write) => write(chalk.red(str))
  });
  
  return program;
}
