/**
 * Login command - OAuth device code flow
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as readline from 'readline';
import { AuthClient } from '@meer/core/auth/client.js';
import { AuthStorage } from '@meer/core/auth/storage.js';
import { loginChatGPTBrowser, loginChatGPTDeviceCode } from '@meer/core/auth/chatgpt/oauth.js';

async function promptLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans); }));
}

function createChatGPTLoginCommand(): Command {
  const cmd = new Command('chatgpt');
  cmd
    .description('Log in with your ChatGPT Plus/Pro account (no API key needed)')
    .option('--device', 'Use device code flow instead of browser (for headless/remote)')
    .action(async (opts: { device?: boolean }) => {
      const authStorage = new AuthStorage();

      if (authStorage.isChatGPTAuthenticated()) {
        console.log(chalk.yellow('Already logged in to ChatGPT. Run `meer logout` to remove credentials.'));
        return;
      }

      try {
        let creds;

        if (opts.device) {
          console.log(chalk.bold('\n🔐 ChatGPT Device Code Login\n'));
          const spinner = ora('Requesting device code...').start();
          creds = await loginChatGPTDeviceCode({
            onCode: ({ userCode, verificationUri }) => {
              spinner.stop();
              console.log(chalk.bold.cyan('\n  ╔' + '═'.repeat(54) + '╗'));
              console.log(chalk.bold.cyan('  ║') + chalk.bold.white('  Authorize Meer at ChatGPT'.padEnd(53)) + chalk.bold.cyan('║'));
              console.log(chalk.bold.cyan('  ║'.padEnd(56) + '║'));
              console.log(chalk.bold.cyan('  ║') + `  1. Visit: ${chalk.blue.underline(verificationUri)}`.padEnd(54) + chalk.bold.cyan('║'));
              console.log(chalk.bold.cyan('  ║') + `  2. Enter code: ${chalk.bold.yellow(userCode)}`.padEnd(54) + chalk.bold.cyan('║'));
              console.log(chalk.bold.cyan('  ╚' + '═'.repeat(54) + '╝\n'));
              ora('Waiting for authorization (15 min timeout)...').start().stopAndPersist({ symbol: chalk.cyan('⋯') });
            },
          });
        } else {
          console.log(chalk.bold('\n🔐 ChatGPT Browser Login\n'));
          creds = await loginChatGPTBrowser({
            onUrl: async (url) => {
              console.log(chalk.dim('Opening browser for ChatGPT authorization...\n'));
              try {
                const open = (await import('open')).default;
                await open(url);
                console.log(chalk.green('✓ Browser opened'));
              } catch {
                console.log(chalk.yellow('⚠  Could not open browser automatically'));
              }
              console.log(chalk.dim(`\n  If the browser did not open, visit:\n  ${chalk.blue.underline(url)}\n`));
            },
            onManualPrompt: () => promptLine(
              chalk.dim('\nBrowser timed out. Paste the redirect URL or authorization code: ')
            ),
          });
        }

        authStorage.saveChatGPTCredentials(creds);
        console.log(chalk.green('\n✅ Logged in to ChatGPT successfully!'));
        console.log(chalk.dim(`   Account ID: ${creds.accountId}`));
        console.log(chalk.dim('\n   Set ChatGPT as your provider:'));
        console.log(chalk.white('   meer setup  (choose "chatgpt" as provider)\n'));

      } catch (err) {
        console.log(chalk.red(`\n❌ Login failed: ${err instanceof Error ? err.message : String(err)}\n`));
        process.exit(1);
      }
    });
  return cmd;
}

export function createLoginCommand(): Command {
  const command = new Command('login');
  command.addCommand(createChatGPTLoginCommand());

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
        console.log(chalk.gray('  3. Sign in with Google or GitHub to authorize MeerAI'));
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
