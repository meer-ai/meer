import { Command } from 'commander';
import chalk from 'chalk';
import { createInterface } from 'readline';
import { loadConfig } from '../config.js';
import type { ChatMessage } from '../providers/base.js';

export function createChatCommand(): Command {
  const command = new Command('chat');
  
  command
    .description('Start an interactive chat session')
    .action(async () => {
      try {
        const config = loadConfig();
        const rl = createInterface({
          input: process.stdin,
          output: process.stdout
        });
        
        console.log(chalk.blue(`\n🤖 DevAI Chat (${config.providerType}: ${config.model})`));
        console.log(chalk.gray('Type your messages below. Type "exit" or "quit" to end the session.\n'));
        
        const messages: ChatMessage[] = [];
        
        const askQuestion = (): Promise<string> => {
          return new Promise((resolve) => {
            rl.question(chalk.cyan('You: '), (input) => {
              resolve(input.trim());
            });
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
          
          // Add user message to history
          messages.push({ role: 'user', content: userInput });
          
          // Stream the response
          console.log(chalk.green('\nAI: '));
          let assistantResponse = '';
          
          for await (const chunk of config.provider.stream(messages)) {
            process.stdout.write(chunk);
            assistantResponse += chunk;
          }
          
          // Add assistant response to history
          messages.push({ role: 'assistant', content: assistantResponse });
          console.log('\n');
        }
        
        rl.close();
        console.log(chalk.gray('\nChat session ended.'));
        
      } catch (error) {
        console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });
  
  return command;
}
