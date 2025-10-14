import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '../config.js';
import { collectRepoFiles, topK, formatContext } from '../context/collect.js';
import type { ChatMessage } from '../providers/base.js';
import { WorkflowTimeline } from '../ui/workflowTimeline.js';

export function createAskCommand(): Command {
  const command = new Command('ask');
  
  command
    .description('Ask a question about the codebase')
    .argument('<question...>', 'The question to ask')
    .option('--no-context', 'Disable code context collection')
    .action(async (questionParts: string[], options: { context?: boolean }) => {
      const timeline = new WorkflowTimeline();

      try {
        const question = questionParts.join(' ');
        const config = loadConfig();

        timeline.info(
          `Provider: ${config.providerType} • Model: ${config.model}`,
          { icon: "🌊" }
        );

        if (config.contextEmbedding?.enabled) {
          const { ProjectContextManager } = await import('../context/manager.js');
          ProjectContextManager.getInstance().configureEmbeddings({
            enabled: true,
            dimensions: config.contextEmbedding.dimensions,
            maxFileSize: config.contextEmbedding.maxFileSize,
          });
        }

        const messages: ChatMessage[] = [];

        if (options.context === false) {
          timeline.warn('Context collection disabled (--no-context)');
          messages.push({ role: 'user', content: question });
        } else {
          const scanTask = timeline.startTask('Collect project files', {
            detail: 'scanning repository',
          });

          const { chunks, totalFiles } = collectRepoFiles();
          timeline.succeed(
            scanTask,
            totalFiles > 0 ? `${totalFiles} files` : 'no files'
          );

          if (chunks.length > 0) {
            const selectTask = timeline.startTask('Select relevant code', {
              detail: `${chunks.length} chunks`,
            });

            const relevantChunks = await topK(
              question,
              config.provider,
              chunks,
              3,
              config.contextEmbedding?.enabled ?? false
            );

            if (relevantChunks.length > 0) {
              timeline.succeed(
                selectTask,
                `${relevantChunks.length} matched`
              );
              const context = formatContext(relevantChunks);
              messages.push({
                role: 'user',
                content: context + question,
              });
            } else {
              timeline.succeed(selectTask, '0 matched');
              timeline.warn('No relevant code chunks found, proceeding without context');
              messages.push({ role: 'user', content: question });
            }
          } else {
            timeline.warn('No code files under 50KB found, proceeding without context');
            messages.push({ role: 'user', content: question });
          }
        }

        const thinkingTask = timeline.startTask('Thinking', {
          detail: `${config.providerType}:${config.model}`,
        });

        let streamStarted = false;
        let headerPrinted = false;

        const printHeader = () => {
          if (!headerPrinted) {
            console.log(chalk.green('\n🤖 Answer:\n'));
            headerPrinted = true;
          }
        };

        try {
          for await (const chunk of config.provider.stream(messages)) {
            if (!streamStarted) {
              streamStarted = true;
              timeline.succeed(thinkingTask, 'Streaming response');
              printHeader();
            }

            if (chunk) {
              process.stdout.write(chunk);
            }
          }
        } catch (streamError) {
          // Mark thinking task as failed before rethrowing
          timeline.fail(
            thinkingTask,
            streamError instanceof Error ? streamError.message : String(streamError)
          );
          throw streamError;
        }

        if (!streamStarted) {
          const response = await config.provider.chat(messages);
          timeline.succeed(thinkingTask, 'Response ready');
          printHeader();
          console.log(response);
        } else {
          console.log('\n');
        }

        timeline.close();
      } catch (error) {
        timeline.close();
        console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });
  
  return command;
}
