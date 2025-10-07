/**
 * Whoami command - Display current user info
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { AuthStorage } from '../auth/storage.js';

export function createWhoamiCommand(): Command {
  const command = new Command('whoami');

  command
    .description('Display current user information')
    .action(async () => {
      const authStorage = new AuthStorage();

      if (!authStorage.isAuthenticated()) {
        console.log(chalk.yellow('\n⚠️  Not logged in'));
        console.log(chalk.gray('   Run "meer login" to authenticate\n'));
        return;
      }

      try {
        const user = authStorage.getUser();

        if (!user) {
          console.log(chalk.yellow('\n⚠️  No user information found\n'));
          return;
        }

        console.log(chalk.bold.blue('\n👤 Current User\n'));
        console.log(chalk.white('   Name: ') + chalk.cyan(user.name));
        console.log(chalk.white('   Email: ') + chalk.gray(user.email));
        console.log(chalk.white('   ID: ') + chalk.gray(user.id));
        console.log(chalk.white('   Tier: ') + chalk.yellow(user.subscription_tier));

        if (user.avatar_url) {
          console.log(chalk.white('   Avatar: ') + chalk.blue.underline(user.avatar_url));
        }

        console.log(chalk.white('   Member since: ') + chalk.gray(new Date(user.created_at).toLocaleDateString()));
        console.log('');

      } catch (error) {
        console.log(chalk.red('\n❌ Error:'));
        console.log(chalk.gray(`   ${error instanceof Error ? error.message : 'Unknown error'}`));
        console.log('');
      }
    });

  return command;
}
