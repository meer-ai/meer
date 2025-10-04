import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { memory } from '../memory/index.js';

export function createMemoryCommand(): Command {
  const memoryCmd = new Command('memory')
    .description('View or manage local memory')
    .action(async () => {
      await showMemoryMenu();
    });

  memoryCmd
    .command('stats')
    .description('Show memory statistics')
    .action(() => {
      const stats = memory.getStats();

      console.log(chalk.bold.blue('\n📊 Memory Statistics:\n'));
      console.log(chalk.white('  Sessions:') + ' ' + chalk.yellow(stats.sessionCount));
      console.log(chalk.white('  Total messages:') + ' ' + chalk.yellow(stats.totalMessages));
      console.log(chalk.white('  Longterm facts:') + ' ' + chalk.gray(stats.longtermFacts + ' (coming soon)'));
      console.log(chalk.white('  Disk usage:') + ' ' + chalk.yellow(stats.diskUsage));
      console.log('');
    });

  memoryCmd
    .command('purge')
    .description('Clear all session history')
    .action(async () => {
      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: 'Are you sure you want to delete all session history?',
          default: false
        }
      ]);

      if (confirm) {
        memory.purgeSessions();
        console.log(chalk.green('\n✅ All sessions purged\n'));
      } else {
        console.log(chalk.gray('\nCancelled\n'));
      }
    });

  memoryCmd
    .command('view')
    .description('View current session')
    .action(() => {
      const session = memory.loadCurrentSession();

      if (session.length === 0) {
        console.log(chalk.yellow('\n⚠️  No messages in current session\n'));
        return;
      }

      console.log(chalk.bold.blue(`\n📝 Current Session (${memory.getCurrentSessionId()}):\n`));

      session.forEach((entry, i) => {
        const roleColor = entry.role === 'user' ? chalk.cyan : chalk.green;
        const roleLabel = entry.role === 'user' ? 'You' : 'AI';
        const timestamp = new Date(entry.timestamp).toLocaleTimeString();

        console.log(roleColor(`${i + 1}. [${timestamp}] ${roleLabel}:`));
        console.log(chalk.gray(entry.content.substring(0, 200) + (entry.content.length > 200 ? '...' : '')));
        console.log('');
      });
    });

  return memoryCmd;
}

async function showMemoryMenu(): Promise<void> {
  const stats = memory.getStats();

  console.log(chalk.bold.blue('\n🧠 Memory Management\n'));
  console.log(chalk.white('Sessions:') + ' ' + chalk.yellow(stats.sessionCount));
  console.log(chalk.white('Messages:') + ' ' + chalk.yellow(stats.totalMessages));
  console.log(chalk.white('Disk:') + ' ' + chalk.yellow(stats.diskUsage));
  console.log('');

  const { action } = await inquirer.prompt([
    {
      type: 'list',
      name: 'action',
      message: 'What would you like to do?',
      choices: [
        { name: '📊 View statistics', value: 'stats' },
        { name: '📝 View current session', value: 'view' },
        { name: '🗑️  Purge all sessions', value: 'purge' },
        new inquirer.Separator(),
        { name: chalk.gray('Cancel'), value: 'cancel' }
      ]
    }
  ]);

  switch (action) {
    case 'stats':
      console.log(chalk.bold.blue('\n📊 Detailed Statistics:\n'));
      console.log(chalk.white('  Sessions:') + ' ' + chalk.yellow(stats.sessionCount));
      console.log(chalk.white('  Total messages:') + ' ' + chalk.yellow(stats.totalMessages));
      console.log(chalk.white('  Longterm facts:') + ' ' + chalk.gray(stats.longtermFacts + ' (coming soon)'));
      console.log(chalk.white('  Disk usage:') + ' ' + chalk.yellow(stats.diskUsage));
      console.log('');
      break;

    case 'view':
      const session = memory.loadCurrentSession();
      if (session.length === 0) {
        console.log(chalk.yellow('\n⚠️  No messages in current session\n'));
      } else {
        console.log(chalk.bold.blue(`\n📝 Current Session (${memory.getCurrentSessionId()}):\n`));
        session.forEach((entry, i) => {
          const roleColor = entry.role === 'user' ? chalk.cyan : chalk.green;
          const roleLabel = entry.role === 'user' ? 'You' : 'AI';
          const timestamp = new Date(entry.timestamp).toLocaleTimeString();

          console.log(roleColor(`${i + 1}. [${timestamp}] ${roleLabel}:`));
          console.log(chalk.gray(entry.content.substring(0, 150) + (entry.content.length > 150 ? '...' : '')));
          console.log('');
        });
      }
      break;

    case 'purge':
      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: chalk.red('⚠️  Are you sure you want to delete ALL session history?'),
          default: false
        }
      ]);

      if (confirm) {
        memory.purgeSessions();
        console.log(chalk.green('\n✅ All sessions purged\n'));
      } else {
        console.log(chalk.gray('\nCancelled\n'));
      }
      break;

    case 'cancel':
      console.log(chalk.gray('\nCancelled\n'));
      break;
  }
}
