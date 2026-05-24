import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { memory } from '../memory/index.js';

function formatRole(role: 'user' | 'assistant' | 'system' | 'tool') {
  if (role === 'user') {
    return { color: chalk.cyan, label: 'You' };
  }
  if (role === 'system') {
    return { color: chalk.yellow, label: 'System' };
  }
  if (role === 'tool') {
    return { color: chalk.magenta, label: 'Tool' };
  }
  return { color: chalk.green, label: 'AI' };
}

function printSessionSummary(limit = 20): void {
  const sessions = memory.listSessions(process.cwd()).slice(0, limit);

  console.log(chalk.bold.blue('\n🗂️  Project Sessions:\n'));
  if (sessions.length === 0) {
    console.log(chalk.gray('  No saved sessions for this project.\n'));
    return;
  }

  sessions.forEach((session, index) => {
    const created = new Date(session.createdAt).toLocaleString();
    const parent = session.parentSessionId
      ? chalk.gray(` ← fork of ${session.parentSessionId.slice(0, 8)}`)
      : '';
    console.log(
      `${chalk.cyan(String(index + 1).padStart(2, ' '))}. ` +
        `${chalk.yellow(session.id.slice(0, 8))} ` +
        `${chalk.gray(`(${session.messageCount} msgs • ${created})`)}${parent}`
    );
  });
  console.log('');
}

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
    .command('list')
    .description('List saved sessions for the current project')
    .action(() => {
      printSessionSummary();
    });

  memoryCmd
    .command('view')
    .description('View current session')
    .argument('[session]', 'Optional session id prefix or session file path')
    .action((sessionArg?: string) => {
      const session = sessionArg
        ? (() => {
            const resolved = memory.resolveSession(sessionArg, process.cwd());
            return resolved ? memory.loadSessionView(resolved.path) : null;
          })()
        : memory.loadCurrentSessionView();

      if (!session || session.entries.length === 0) {
        console.log(
          chalk.yellow(
            sessionArg
              ? `\n⚠️  No messages found for session '${sessionArg}'\n`
              : '\n⚠️  No messages in current session\n'
          )
        );
        return;
      }

      console.log(chalk.bold.blue(`\n📝 Current Session (${session.sessionId}):\n`));
      console.log(chalk.gray(`  ${session.sessionLabel}`));
      console.log('');

      session.entries.forEach((entry, i) => {
        const { color: roleColor, label: roleLabel } = formatRole(entry.role);
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
        { name: '🗂️  List project sessions', value: 'list' },
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
      const session = memory.loadCurrentSessionView();
      if (!session || session.entries.length === 0) {
        console.log(chalk.yellow('\n⚠️  No messages in current session\n'));
      } else {
        console.log(chalk.bold.blue(`\n📝 Current Session (${session.sessionId}):\n`));
        console.log(chalk.gray(`  ${session.sessionLabel}`));
        console.log('');
        session.entries.forEach((entry, i) => {
          const { color: roleColor, label: roleLabel } = formatRole(entry.role);
          const timestamp = new Date(entry.timestamp).toLocaleTimeString();

          console.log(roleColor(`${i + 1}. [${timestamp}] ${roleLabel}:`));
          console.log(chalk.gray(entry.content.substring(0, 150) + (entry.content.length > 150 ? '...' : '')));
          console.log('');
        });
      }
      break;

    case 'list':
      printSessionSummary();
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
