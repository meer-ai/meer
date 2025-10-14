/**
 * Index Command - Index project files for semantic search
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { SemanticSearchEngine } from '../search/semanticEngine.js';
import { loadConfig } from '../config.js';

export function createIndexCommand(): Command {
  const command = new Command('index');

  command
    .description('Index project files for semantic search')
    .argument('[path]', 'Path to index (defaults to current directory)')
    .option('--reindex', 'Force reindex all files')
    .option('--status', 'Show indexing status')
    .option('--clear', 'Clear the index')
    .option('--model <model>', 'Embedding model to use (default: nomic-embed-text)')
    .action(async (path: string | undefined, options: {
      reindex?: boolean;
      status?: boolean;
      clear?: boolean;
      model?: string;
    }) => {
      try {
        const cwd = path || process.cwd();
        const config = loadConfig();

        // Check if provider supports embeddings
        const provider = config.provider;

        if (!provider.embed) {
          console.log(chalk.red('❌ Error: Current provider does not support embeddings'));
          console.log(chalk.yellow('\n💡 Tip: Switch to a provider that supports embeddings:'));
          console.log(chalk.gray('  • Ollama (free, local)'));
          console.log(chalk.gray('  • OpenRouter'));
          console.log(chalk.gray('  • OpenAI'));
          console.log(chalk.gray(`\nRun: ${chalk.cyan('meer setup')} to change providers\n`));
          process.exit(1);
        }

        const embeddingModel = options.model || 'nomic-embed-text';
        const engine = new SemanticSearchEngine(cwd, provider, embeddingModel);

        // Handle --status flag
        if (options.status) {
          console.log(chalk.bold.blue('\n📊 Index Status:\n'));

          const stats = engine.getIndexStats();

          console.log(chalk.white('  Project:') + '     ' + chalk.cyan(cwd));
          console.log(chalk.white('  Model:') + '       ' + chalk.green(stats.model));
          console.log(chalk.white('  Files:') + '       ' + chalk.yellow(stats.totalFiles));
          console.log(chalk.white('  Chunks:') + '      ' + chalk.yellow(stats.totalChunks));
          console.log(chalk.white('  Dimensions:') + '  ' + chalk.gray(stats.dimensions || 'Not set'));

          if (stats.lastIndexed) {
            console.log(chalk.white('  Last Index:') + '  ' + chalk.gray(stats.lastIndexed.toLocaleString()));
          } else {
            console.log(chalk.white('  Last Index:') + '  ' + chalk.gray('Never'));
          }

          console.log('');

          if (stats.totalChunks === 0) {
            console.log(chalk.yellow('⚠️  No files indexed yet'));
            console.log(chalk.gray(`Run: ${chalk.cyan('meer index')} to index your project\n`));
          } else {
            console.log(chalk.green('✓ Index is ready for semantic search\n'));
          }

          return;
        }

        // Handle --clear flag
        if (options.clear) {
          console.log(chalk.yellow('\n⚠️  Clear index functionality not yet implemented\n'));
          // TODO: Implement clear index
          return;
        }

        // Index the project
        const spinner = ora(chalk.blue('Indexing project files...')).start();

        try {
          await engine.reindex();
          spinner.succeed(chalk.green('✓ Project indexed successfully'));

          const stats = engine.getIndexStats();
          console.log(chalk.gray(`  Indexed ${stats.totalFiles} files, ${stats.totalChunks} code chunks`));
          console.log('');
          console.log(chalk.green('✓ Semantic search is now available!'));
          console.log(chalk.gray('  Use semantic_search in chat or via agent workflow\n'));

        } catch (error) {
          spinner.fail(chalk.red('Failed to index project'));
          console.log(chalk.red('\n❌ Error:'), error instanceof Error ? error.message : String(error));
          console.log(chalk.yellow('\n💡 Common issues:'));
          console.log(chalk.gray('  • Provider not running (e.g., Ollama)'));
          console.log(chalk.gray('  • Invalid API key'));
          console.log(chalk.gray('  • Network connectivity issues'));
          console.log(chalk.gray('  • Model not available\n'));
          process.exit(1);
        }

      } catch (error) {
        console.error(
          chalk.red('Error:'),
          error instanceof Error ? error.message : String(error)
        );
        process.exit(1);
      }
    });

  return command;
}
