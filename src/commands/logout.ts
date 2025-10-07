/**
 * Logout command
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { AuthStorage } from '../auth/storage.js';

export function createLogoutCommand(): Command {
  const command = new Command('logout');

  command
    .description('Sign out of MeerAI')
    .action(async () => {
      const authStorage = new AuthStorage();

      // Check if logged in
      if (!authStorage.isAuthenticated()) {
        console.log(chalk.yellow('\n⚠️  Not currently logged in\n'));
        return;
      }

      try {
        const user = authStorage.getUser();
        authStorage.clear();

        console.log(chalk.green('\n✅ Successfully logged out'));
        if (user) {
          console.log(chalk.gray(`   Signed out: ${user.name} (${user.email})`));
        }
        console.log('');
      } catch (error) {
        console.log(chalk.red('\n❌ Logout failed:'));
        console.log(chalk.gray(`   ${error instanceof Error ? error.message : 'Unknown error'}`));
        console.log('');
      }
    });

  return command;
}
