import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { execSync } from 'child_process';
import { loadConfig } from '../config.js';
import type { ChatMessage } from '../providers/base.js';

interface CommitType {
  type: string;
  emoji: string;
  description: string;
  color: (text: string) => string;
}

const COMMIT_TYPES: CommitType[] = [
  { type: 'feat', emoji: '✨', description: 'A new feature', color: chalk.green },
  { type: 'fix', emoji: '🐛', description: 'A bug fix', color: chalk.red },
  { type: 'docs', emoji: '📝', description: 'Documentation changes', color: chalk.blue },
  { type: 'style', emoji: '💄', description: 'Code style changes (formatting, etc)', color: chalk.magenta },
  { type: 'refactor', emoji: '♻️', description: 'Code refactoring', color: chalk.cyan },
  { type: 'perf', emoji: '⚡', description: 'Performance improvements', color: chalk.yellow },
  { type: 'test', emoji: '✅', description: 'Adding or updating tests', color: chalk.green },
  { type: 'build', emoji: '🔧', description: 'Build system or dependencies', color: chalk.gray },
  { type: 'ci', emoji: '👷', description: 'CI/CD changes', color: chalk.blue },
  { type: 'chore', emoji: '🔨', description: 'Other changes (tooling, etc)', color: chalk.gray },
  { type: 'revert', emoji: '⏪', description: 'Revert a previous commit', color: chalk.red }
];

export function createCommitMsgCommand(): Command {
  const command = new Command('commit-msg');

  command
    .description('Generate a commit message from staged changes')
    .option('-c, --conventional', 'Use conventional commits format')
    .option('-e, --emoji', 'Include emojis in commit message')
    .option('--no-interactive', 'Skip interactive prompts')
    .option('--commit', 'Automatically commit with generated message')
    .action(async (options: { conventional?: boolean; emoji?: boolean; interactive?: boolean; commit?: boolean }) => {
      try {
        // Get staged changes
        let diff: string;
        try {
          diff = execSync('git diff --staged', { encoding: 'utf-8' });
        } catch {
          throw new Error('No staged changes found. Please stage some changes first with `git add`.');
        }

        if (!diff.trim()) {
          throw new Error('No staged changes found. Please stage some changes first with `git add`.');
        }
        
        const config = loadConfig();

        if (config.contextEmbedding?.enabled) {
          const { ProjectContextManager } = await import("../context/manager.js");
          ProjectContextManager.getInstance().configureEmbeddings({
            enabled: true,
            dimensions: config.contextEmbedding.dimensions,
            maxFileSize: config.contextEmbedding.maxFileSize,
          });
        }

        // Interactive type selection for conventional commits
        let selectedType: CommitType | null = null;
        let scope = '';

        if (options.conventional && options.interactive !== false) {
          console.log(chalk.bold.cyan('\n📋 Commit Type Selection\n'));

          const { commitType } = await inquirer.prompt([
            {
              type: 'list',
              name: 'commitType',
              message: 'Select commit type:',
              choices: COMMIT_TYPES.map(ct => ({
                name: `${ct.emoji}  ${chalk.bold(ct.type.padEnd(10))} - ${chalk.gray(ct.description)}`,
                value: ct.type,
                short: ct.type
              })),
              pageSize: 11
            }
          ]);

          selectedType = COMMIT_TYPES.find(ct => ct.type === commitType) || null;

          const { commitScope } = await inquirer.prompt([
            {
              type: 'input',
              name: 'commitScope',
              message: 'Scope (optional, e.g., "api", "ui", "auth"):',
              default: ''
            }
          ]);

          scope = commitScope;
        }

        // Show analysis spinner
        const analysisSpinner = ora({
          text: chalk.blue('Analyzing git changes...'),
          spinner: 'dots',
          color: 'blue'
        }).start();

        // Simulate analysis time
        await new Promise(resolve => setTimeout(resolve, 600));
        analysisSpinner.stop();
        
        // Build system prompt based on options
        let systemPrompt = 'You write excellent concise commit messages. Follow these rules:\n';

        if (options.conventional && selectedType) {
          systemPrompt += `- Use conventional commits format: ${selectedType.type}${scope ? `(${scope})` : ''}: <description>\n`;
          systemPrompt += `- The type is already selected as "${selectedType.type}"${scope ? ` with scope "${scope}"` : ''}\n`;
          systemPrompt += '- Only generate the description part (after the colon)\n';
        } else if (options.conventional) {
          systemPrompt += '- Use conventional commits format: type(scope): description\n';
          systemPrompt += '- Choose appropriate type: feat, fix, docs, style, refactor, perf, test, build, ci, chore\n';
          systemPrompt += '- Include scope in parentheses if applicable\n';
        } else {
          systemPrompt += '- Start with a verb in imperative mood (e.g., "Add", "Fix", "Update", "Remove")\n';
        }

        systemPrompt += '- Keep the title under 50 characters\n';

        if (options.emoji && selectedType) {
          systemPrompt += `- Start the message with the emoji ${selectedType.emoji}\n`;
        } else if (options.emoji) {
          systemPrompt += '- Include a relevant emoji at the start (e.g., ✨ for features, 🐛 for fixes)\n';
        }

        systemPrompt += '- Focus on what changed and why, not how\n';
        systemPrompt += '- Be specific about the scope and impact\n';
        systemPrompt += '- Mention breaking changes if any (use BREAKING CHANGE: in body)\n';
        systemPrompt += '- Output only the commit message, no additional text or explanations';

        const messages: ChatMessage[] = [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: `Generate a commit message for these changes:\n\n${diff}`
          }
        ];
        
        // Show generation spinner
        const generateSpinner = ora({
          text: chalk.blue('Generating commit message...'),
          spinner: 'dots',
          color: 'blue'
        }).start();

        // Simulate generation time
        await new Promise(resolve => setTimeout(resolve, 800));
        generateSpinner.stop();

        // Show thinking indicator until first response
        const responseSpinner = ora({
          text: chalk.blue('AI is thinking...'),
          spinner: 'dots',
          color: 'blue'
        }).start();

        let commitMessage = '';
        let isFirstChunk = true;
        let hasStarted = false;

        for await (const chunk of config.provider.stream(messages)) {
          if (isFirstChunk && !hasStarted) {
            // Stop thinking spinner when first chunk arrives
            responseSpinner.stop();
            hasStarted = true;
          }
          if (isFirstChunk) {
            isFirstChunk = false;
          }
          commitMessage += chunk;
        }

        // Make sure spinner is stopped
        if (!hasStarted) {
          responseSpinner.stop();
        }

        // Clean up the response
        let cleanMessage = commitMessage.trim().split('\n').filter(line =>
          !line.startsWith('Here') &&
          !line.startsWith('Based') &&
          !line.startsWith('I\'ll') &&
          line.trim().length > 0
        ).join('\n');

        // Add conventional commit prefix if needed
        if (options.conventional && selectedType) {
          const prefix = `${selectedType.type}${scope ? `(${scope})` : ''}: `;
          const emoji = options.emoji ? `${selectedType.emoji} ` : '';

          // Check if message already has the prefix
          if (!cleanMessage.startsWith(selectedType.type)) {
            cleanMessage = prefix + cleanMessage;
          }

          // Add emoji if requested
          if (options.emoji && !cleanMessage.includes(selectedType.emoji)) {
            cleanMessage = emoji + cleanMessage;
          }
        }

        // Display the generated commit message with nice formatting
        console.log(chalk.bold.cyan('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
        console.log(chalk.bold.green('  📝 Generated Commit Message'));
        console.log(chalk.bold.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

        // Split message into title and body for better formatting
        const messageParts = cleanMessage.split('\n');
        const title = messageParts[0];
        const body = messageParts.slice(1).join('\n');

        // Display title with color based on type
        if (selectedType) {
          console.log('  ' + selectedType.color(chalk.bold(title)));
        } else {
          console.log('  ' + chalk.bold.white(title));
        }

        if (body.trim()) {
          console.log(chalk.gray('\n  ' + body.split('\n').join('\n  ')));
        }

        console.log(chalk.bold.cyan('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

        // Interactive options
        if (options.interactive !== false && !options.commit) {
          const { action } = await inquirer.prompt([
            {
              type: 'list',
              name: 'action',
              message: 'What would you like to do?',
              choices: [
                { name: '✅ Commit with this message', value: 'commit' },
                { name: '✏️  Edit message', value: 'edit' },
                { name: '📋 Copy to clipboard', value: 'copy' },
                { name: '❌ Cancel', value: 'cancel' }
              ]
            }
          ]);

          if (action === 'edit') {
            const { editedMessage } = await inquirer.prompt([
              {
                type: 'editor',
                name: 'editedMessage',
                message: 'Edit commit message:',
                default: cleanMessage
              }
            ]);
            cleanMessage = editedMessage.trim();

            // Ask again after editing
            const { commitAfterEdit } = await inquirer.prompt([
              {
                type: 'confirm',
                name: 'commitAfterEdit',
                message: 'Commit with edited message?',
                default: true
              }
            ]);

            if (commitAfterEdit) {
              try {
                execSync(`git commit -m "${cleanMessage.replace(/"/g, '\\"')}"`, { stdio: 'inherit' });
                console.log(chalk.green('\n✓ Changes committed successfully!\n'));
              } catch (error) {
                console.error(chalk.red('\n✗ Failed to commit changes\n'));
              }
            }
          } else if (action === 'commit') {
            try {
              execSync(`git commit -m "${cleanMessage.replace(/"/g, '\\"')}"`, { stdio: 'inherit' });
              console.log(chalk.green('\n✓ Changes committed successfully!\n'));
            } catch (error) {
              console.error(chalk.red('\n✗ Failed to commit changes\n'));
            }
          } else if (action === 'copy') {
            console.log(chalk.blue('\nℹ To copy to clipboard, use: meer commit-msg | pbcopy (macOS) or | clip (Windows)\n'));
            console.log(chalk.gray('Message:\n'));
            console.log(cleanMessage);
            console.log('\n');
          }
        } else if (options.commit) {
          // Auto-commit if --commit flag is used
          try {
            execSync(`git commit -m "${cleanMessage.replace(/"/g, '\\"')}"`, { stdio: 'inherit' });
            console.log(chalk.green('✓ Changes committed successfully!\n'));
          } catch (error) {
            console.error(chalk.red('✗ Failed to commit changes\n'));
          }
        } else {
          // Just print the message if non-interactive
          console.log(cleanMessage);
          console.log('\n');
        }
        
      } catch (error) {
        throw error;
      }
    });

  return command;
}
