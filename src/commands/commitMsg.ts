import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { execSync } from 'child_process';
import { loadConfig } from '../config.js';
import type { ChatMessage } from '../providers/base.js';

export function createCommitMsgCommand(): Command {
  const command = new Command('commit-msg');
  
  command
    .description('Generate a commit message from staged changes')
    .action(async () => {
      try {
        // Get staged changes
        let diff: string;
        try {
          diff = execSync('git diff --staged', { encoding: 'utf-8' });
        } catch (error) {
          console.error(chalk.red('Error: No staged changes found. Please stage some changes first with `git add`.'));
          process.exit(1);
        }
        
        if (!diff.trim()) {
          console.error(chalk.red('Error: No staged changes found. Please stage some changes first with `git add`.'));
          process.exit(1);
        }
        
        const config = loadConfig();
        
        // Show analysis spinner
        const analysisSpinner = ora({
          text: chalk.blue('Analyzing git changes...'),
          spinner: 'dots',
          color: 'blue'
        }).start();
        
        // Simulate analysis time
        await new Promise(resolve => setTimeout(resolve, 600));
        analysisSpinner.stop();
        
        const messages: ChatMessage[] = [
          {
            role: 'system',
            content: 'You write excellent concise imperative commit messages. Follow these rules:\n' +
              '- Start with a verb in imperative mood (e.g., "Add", "Fix", "Update", "Remove")\n' +
              '- Keep the title under 50 characters\n' +
              '- Use bullet points for additional details if needed\n' +
              '- Focus on what changed and why, not how\n' +
              '- Be specific about the scope and impact\n' +
              '- Mention breaking changes if any\n' +
              '- Output only the commit message, no additional text'
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
        
        // Stream the response
        console.log(chalk.green('\n📝 Commit Message:\n'));
        
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
            await new Promise(resolve => setTimeout(resolve, 200));
          }
          if (isFirstChunk) {
            isFirstChunk = false;
          }
          process.stdout.write(chunk);
          commitMessage += chunk;
        }
        
        // Make sure spinner is stopped
        if (!hasStarted) {
          responseSpinner.stop();
        }
        
        // Clean up the response
        const cleanMessage = commitMessage.trim().split('\n').filter(line => 
          !line.startsWith('Here') && 
          !line.startsWith('Based') &&
          !line.startsWith('I\'ll') &&
          line.trim().length > 0
        ).join('\n');
        
        console.log('\n');
        
      } catch (error) {
        console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });
  
  return command;
}
