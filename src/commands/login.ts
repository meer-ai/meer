/**
 * Login command - OAuth device code flow
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { AuthClient } from '../auth/client.js';
import { AuthStorage } from '../auth/storage.js';

export function createLoginCommand(): Command {
  const command = new Command('login');

  command
    .description('Authenticate with MeerAI backend')
    .option('--api-url <url>', 'Backend API URL', process.env.MEERAI_API_URL || 'https://api.meerai.dev')
    .action(async (options) => {
      console.log(chalk.bold.blue('\n🔐 MeerAI Login\n'));

      const authClient = new AuthClient(options.apiUrl);
      const authStorage = new AuthStorage();

      // Check if already logged in
      if (authStorage.isAuthenticated()) {
        const user = authStorage.getUser();
        console.log(chalk.yellow('⚠️  Already logged in as:'));
        console.log(chalk.white(`   ${user?.name} (${user?.email})`));
        console.log(chalk.gray('\n💡 Use "meer logout" to sign out first\n'));
        return;
      }

      try {
        // Step 1: Initialize device code flow
        const spinner = ora(chalk.blue('Initializing authentication...')).start();
        const deviceCodeResponse = await authClient.initializeDeviceCode();
        spinner.succeed(chalk.green('Authentication initialized'));

        // Step 2: Display user code and verification URL
        console.log('');
        console.log(chalk.bold.cyan('━'.repeat(60)));
        console.log(chalk.bold.white('  Please complete authentication in your browser:'));
        console.log('');
        console.log(chalk.white('  1. Visit: ') + chalk.blue.underline(deviceCodeResponse.verification_uri));
        console.log(chalk.white('  2. Enter code: ') + chalk.bold.yellow(deviceCodeResponse.user_code));
        console.log('');
        console.log(chalk.gray(`  Code expires in ${Math.floor(deviceCodeResponse.expires_in / 60)} minutes`));
        console.log(chalk.bold.cyan('━'.repeat(60)));
        console.log('');

        // Step 3: Open browser
        try {
          const open = (await import('open')).default;
          await open(deviceCodeResponse.verification_uri);
          console.log(chalk.green('✓ Browser opened automatically\n'));
        } catch (error) {
          console.log(chalk.yellow('⚠️  Could not open browser automatically'));
          console.log(chalk.gray('   Please open the URL manually\n'));
        }

        // Step 4: Poll for authorization
        const pollSpinner = ora(chalk.blue('Waiting for authorization...')).start();

        const startTime = Date.now();
        const expiresMs = deviceCodeResponse.expires_in * 1000;
        const intervalMs = deviceCodeResponse.interval * 1000;

        let tokenResponse = null;

        while (!tokenResponse) {
          // Check if expired
          if (Date.now() - startTime > expiresMs) {
            pollSpinner.fail(chalk.red('Device code expired'));
            console.log(chalk.yellow('\n⏱️  The code has expired. Please try again.\n'));
            return;
          }

          // Wait for interval
          await new Promise(resolve => setTimeout(resolve, intervalMs));

          try {
            tokenResponse = await authClient.pollDeviceCode(deviceCodeResponse.device_code);
          } catch (error) {
            pollSpinner.fail(chalk.red('Authentication failed'));
            throw error;
          }
        }

        pollSpinner.succeed(chalk.green('Authenticated successfully!'));

        // Step 5: Save tokens
        authStorage.save({
          access_token: tokenResponse.access_token,
          refresh_token: tokenResponse.refresh_token,
          user: tokenResponse.user,
          expires_at: new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString(),
        });

        // Step 6: Display success message
        console.log('');
        console.log(chalk.green('✅ Successfully logged in!'));
        console.log('');
        console.log(chalk.white('   User: ') + chalk.cyan(tokenResponse.user.name));
        console.log(chalk.white('   Email: ') + chalk.gray(tokenResponse.user.email));
        console.log(chalk.white('   Tier: ') + chalk.yellow(tokenResponse.user.subscription_tier));
        console.log('');
        console.log(chalk.gray('💡 You can now use MeerAI to sync your sessions and templates'));
        console.log('');

      } catch (error) {
        console.log(chalk.red('\n❌ Login failed:'));
        console.log(chalk.gray(`   ${error instanceof Error ? error.message : 'Unknown error'}`));
        console.log('');
      }
    });

  return command;
}
