import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { loadConfig } from '../config.js';
import { collectRepoFiles, topK, formatContext } from '../context/collect.js';
import type { ChatMessage } from '../providers/base.js';

export function createAskCommand(): Command {
  const command = new Command('ask');
  
  command
    .description('Ask a question about the codebase')
    .argument('<question...>', 'The question to ask')
    .option('--no-context', 'Disable code context collection')
    .action(async (questionParts: string[], options: { context?: boolean }) => {
      try {
        const question = questionParts.join(' ');
        const config = loadConfig();
        
        console.log(chalk.blue(`Using provider: ${config.providerType} - Model: ${config.model}`));
        
        const messages: ChatMessage[] = [];
        
        // Add context if enabled
        if (options.context !== false) {
          const contextSpinner = ora({
            text: chalk.blue('Collecting code context...'),
            spinner: 'dots',
            color: 'blue'
          }).start();
          
          const { chunks } = collectRepoFiles();
          
          if (chunks.length > 0) {
            contextSpinner.text = chalk.blue(`Found ${chunks.length} code chunks, finding relevant ones...`);
            const relevantChunks = await topK(question, config.provider, chunks);
            
            if (relevantChunks.length > 0) {
              const context = formatContext(relevantChunks);
              messages.push({
                role: 'user',
                content: context + question
              });
              contextSpinner.succeed(chalk.green(`Found ${relevantChunks.length} relevant code chunks`));
            } else {
              messages.push({ role: 'user', content: question });
              contextSpinner.warn(chalk.yellow('No relevant code chunks found, proceeding without context'));
            }
          } else {
            messages.push({ role: 'user', content: question });
            contextSpinner.warn(chalk.yellow('No code files found, proceeding without context'));
          }
          contextSpinner.stop();
        } else {
          messages.push({ role: 'user', content: question });
        }
        
        // Show thinking spinner
        const thinkingSpinner = ora({
          text: chalk.blue('AI is thinking...'),
          spinner: 'dots',
          color: 'blue'
        }).start();
        
        // Simulate thinking time
        await new Promise(resolve => setTimeout(resolve, 800));
        thinkingSpinner.stop();
        
        // Stream the response
        console.log(chalk.green('\n🤖 Answer:\n'));
        
        // Show thinking indicator until first response
        const responseSpinner = ora({
          text: chalk.blue('AI is thinking...'),
          spinner: 'dots',
          color: 'blue'
        }).start();
        
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
        }
        
        // Make sure spinner is stopped
        if (!hasStarted) {
          responseSpinner.stop();
        }
        
        console.log('\n');
        
      } catch (error) {
        console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });
  
  return command;
}
