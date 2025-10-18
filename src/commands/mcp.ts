/**
 * MCP (Model Context Protocol) Management Commands
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { MCPManager } from '../mcp/manager.js';
import {
  loadMCPConfig,
  toggleServer,
  mcpConfigExists,
  saveMCPConfig,
  checkUvxInstalled,
  displayUvxWarning,
  getUvxRequiredServers,
} from '../mcp/config.js';

export function createMCPCommand(): Command {
  const command = new Command('mcp');

  command
    .description('Manage MCP (Model Context Protocol) servers and integrations')
    .addCommand(createListCommand())
    .addCommand(createToolsCommand())
    .addCommand(createResourcesCommand())
    .addCommand(createConnectCommand())
    .addCommand(createDisconnectCommand())
    .addCommand(createEnableCommand())
    .addCommand(createDisableCommand())
    .addCommand(createStatusCommand())
    .addCommand(createSetupCommand())
    .addCommand(createResetCommand());

  return command;
}

/**
 * List connected MCP servers
 */
function createListCommand(): Command {
  const command = new Command('list');

  command
    .description('List all configured MCP servers')
    .action(async () => {
      try {
        if (!mcpConfigExists()) {
          console.log(chalk.yellow('⚠️  No MCP configuration found'));
          console.log(chalk.gray('Run `meer mcp enable <server>` to get started'));
          return;
        }

        const config = loadMCPConfig();
        const servers = Object.entries(config.mcpServers);

        if (servers.length === 0) {
          console.log(chalk.yellow('⚠️  No MCP servers configured'));
          return;
        }

        console.log(chalk.bold.blue('\n📦 Configured MCP Servers:\n'));

        for (const [name, serverConfig] of servers) {
          const status = serverConfig.enabled
            ? chalk.green('✓ enabled')
            : chalk.gray('○ disabled');

          console.log(`  ${status}  ${chalk.bold(name)}`);
          if (serverConfig.description) {
            console.log(`          ${chalk.gray(serverConfig.description)}`);
          }
          if (serverConfig.url) {
            console.log(`          ${chalk.gray(`URL: ${serverConfig.url}`)}`);
            if (serverConfig.transport) {
              console.log(`          ${chalk.gray(`Transport: ${serverConfig.transport}`)}`);
            }
          } else if (serverConfig.command) {
            const args = serverConfig.args?.join(' ') ?? '';
            const commandLine = args ? `${serverConfig.command} ${args}` : serverConfig.command;
            console.log(`          ${chalk.gray(commandLine)}`);
          }
        }

        console.log('');
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

/**
 * List all available tools from connected servers
 */
function createToolsCommand(): Command {
  const command = new Command('tools');

  command
    .description('List all available MCP tools')
    .action(async () => {
      try {
        const spinner = ora(chalk.blue('Connecting to MCP servers...')).start();

        const manager = MCPManager.getInstance();
        await manager.initialize();

        const tools = manager.listAllTools();
        spinner.stop();

        if (tools.length === 0) {
          console.log(chalk.yellow('\n⚠️  No MCP tools available'));
          console.log(chalk.gray('Enable some MCP servers to get access to tools'));
          console.log(chalk.gray('Run `meer mcp list` to see available servers\n'));
          return;
        }

        console.log(chalk.bold.blue(`\n🔧 Available MCP Tools (${tools.length}):\n`));

        // Group tools by server
        const toolsByServer = new Map<string, typeof tools>();
        for (const tool of tools) {
          if (!toolsByServer.has(tool.serverName)) {
            toolsByServer.set(tool.serverName, []);
          }
          toolsByServer.get(tool.serverName)!.push(tool);
        }

        for (const [serverName, serverTools] of toolsByServer) {
          console.log(chalk.bold.cyan(`  ${serverName} (${serverTools.length} tools):`));
          for (const tool of serverTools) {
            console.log(`    • ${chalk.green(tool.originalName)}`);
            console.log(`      ${chalk.gray(tool.description)}`);
          }
          console.log('');
        }

        await manager.disconnectAll();
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

/**
 * List all available resources from connected servers
 */
function createResourcesCommand(): Command {
  const command = new Command('resources');

  command
    .description('List all available MCP resources')
    .action(async () => {
      try {
        const spinner = ora(chalk.blue('Connecting to MCP servers...')).start();

        const manager = MCPManager.getInstance();
        await manager.initialize();

        const resources = manager.listAllResources();
        spinner.stop();

        if (resources.length === 0) {
          console.log(chalk.yellow('\n⚠️  No MCP resources available\n'));
          return;
        }

        console.log(chalk.bold.blue(`\n📚 Available MCP Resources (${resources.length}):\n`));

        // Group resources by server
        const resourcesByServer = new Map<string, typeof resources>();
        for (const resource of resources) {
          if (!resourcesByServer.has(resource.serverName)) {
            resourcesByServer.set(resource.serverName, []);
          }
          resourcesByServer.get(resource.serverName)!.push(resource);
        }

        for (const [serverName, serverResources] of resourcesByServer) {
          console.log(chalk.bold.cyan(`  ${serverName} (${serverResources.length} resources):`));
          for (const resource of serverResources) {
            console.log(`    • ${chalk.green(resource.name)}`);
            console.log(`      ${chalk.gray(resource.uri)}`);
            if (resource.description) {
              console.log(`      ${chalk.gray(resource.description)}`);
            }
          }
          console.log('');
        }

        await manager.disconnectAll();
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

/**
 * Connect to a specific MCP server
 */
function createConnectCommand(): Command {
  const command = new Command('connect');

  command
    .description('Connect to a specific MCP server')
    .argument('<server>', 'Server name to connect to')
    .action(async (serverName: string) => {
      try {
        // Check if this server requires uvx
        const config = loadMCPConfig();
        const serverConfig = config.mcpServers[serverName];

        if (serverConfig && serverConfig.command === 'uvx' && !checkUvxInstalled()) {
          console.log(chalk.yellow(`\n⚠️  Server "${serverName}" requires uvx which is not installed\n`));
          displayUvxWarning();
          return;
        }

        const spinner = ora(chalk.blue(`Connecting to ${serverName}...`)).start();

        const manager = MCPManager.getInstance();
        await manager.connectServer(serverName);

        const tools = manager.listAllTools().filter(t => t.serverName === serverName);
        const resources = manager.listAllResources().filter(r => r.serverName === serverName);

        spinner.succeed(chalk.green(`Connected to ${serverName}`));

        console.log(chalk.gray(`  Tools: ${tools.length}`));
        console.log(chalk.gray(`  Resources: ${resources.length}`));
        console.log('');

        await manager.disconnectServer(serverName);
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

/**
 * Disconnect from a server
 */
function createDisconnectCommand(): Command {
  const command = new Command('disconnect');

  command
    .description('Disconnect from a specific MCP server')
    .argument('<server>', 'Server name to disconnect from')
    .action(async (serverName: string) => {
      try {
        const manager = MCPManager.getInstance();
        await manager.disconnectServer(serverName);

        console.log(chalk.green(`✓ Disconnected from ${serverName}\n`));
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

/**
 * Enable an MCP server in configuration
 */
function createEnableCommand(): Command {
  const command = new Command('enable');

  command
    .description('Enable an MCP server in configuration')
    .argument('<server>', 'Server name to enable')
    .action(async (serverName: string) => {
      try {
        toggleServer(serverName, true);
        console.log(chalk.green(`✓ Enabled ${serverName}`));
        console.log(chalk.gray('Server will auto-connect on next session\n'));
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

/**
 * Disable an MCP server in configuration
 */
function createDisableCommand(): Command {
  const command = new Command('disable');

  command
    .description('Disable an MCP server in configuration')
    .argument('<server>', 'Server name to disable')
    .action(async (serverName: string) => {
      try {
        toggleServer(serverName, false);
        console.log(chalk.green(`✓ Disabled ${serverName}\n`));
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

/**
 * Show MCP server status
 */
function createStatusCommand(): Command {
  const command = new Command('status');

  command
    .description('Show status of MCP servers')
    .action(async () => {
      try {
        // Check for uvx before trying to connect
        const uvxInstalled = checkUvxInstalled();
        const config = loadMCPConfig();
        const uvxRequiredServers = getUvxRequiredServers(config);

        if (!uvxInstalled && uvxRequiredServers.length > 0) {
          console.log(chalk.yellow('\n⚠️  uvx is not installed'));
          console.log(chalk.gray(`The following enabled servers require uvx: ${uvxRequiredServers.join(', ')}\n`));
          console.log(chalk.gray('Run `meer mcp setup` for installation instructions.\n'));
        }

        const spinner = ora(chalk.blue('Checking MCP server status...')).start();

        const manager = MCPManager.getInstance();
        await manager.initialize();

        const servers = manager.getConnectedServers();
        spinner.stop();

        console.log(chalk.bold.blue(`\n📊 MCP Server Status:\n`));

        if (servers.length === 0) {
          console.log(chalk.yellow('  ⚠️  No servers connected'));
          console.log(chalk.gray('  Enable servers with `meer mcp enable <server>`\n'));
          console.log(chalk.cyan('  💡 Quick start:'));
          console.log(chalk.gray('     • Run `meer mcp setup` for guided configuration'));
          console.log(chalk.gray('     • Or run `meer mcp list` to see available servers\n'));
          return;
        }

        for (const server of servers) {
          const statusIcon = server.status === 'connected'
            ? chalk.green('✓')
            : chalk.red('✗');

          console.log(`  ${statusIcon} ${chalk.bold(server.name)}`);
          console.log(`     Status: ${chalk.gray(server.status)}`);
          console.log(`     Tools: ${chalk.gray(server.tools.length)}`);
          console.log(`     Resources: ${chalk.gray(server.resources.length)}`);
          if (server.connectedAt) {
            console.log(`     Connected: ${chalk.gray(server.connectedAt.toLocaleString())}`);
          }
          console.log('');
        }

        await manager.disconnectAll();
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

/**
 * Interactive MCP setup wizard
 */
function createSetupCommand(): Command {
  const command = new Command('setup');

  command
    .description('Interactive setup wizard for MCP servers')
    .action(async () => {
      try {
        const inquirer = (await import('inquirer')).default;

        console.log(chalk.bold.cyan('\n🔧 MCP Setup Wizard\n'));
        console.log(chalk.gray('This wizard will help you configure Model Context Protocol servers.\n'));

        // Check for uvx installation
        const uvxInstalled = checkUvxInstalled();
        const config = loadMCPConfig();
        const uvxRequiredServers = getUvxRequiredServers(config);

        if (!uvxInstalled && uvxRequiredServers.length > 0) {
          displayUvxWarning();
          console.log(chalk.yellow(`⚠️  The following enabled servers require uvx: ${uvxRequiredServers.join(', ')}\n`));

          const { continueWithout } = await inquirer.prompt([
            {
              type: 'confirm',
              name: 'continueWithout',
              message: 'Do you want to continue setup without uvx? (You can install it later)',
              default: false,
            },
          ]);

          if (!continueWithout) {
            console.log(chalk.gray('\nSetup cancelled. Please install uvx and try again.\n'));
            return;
          }
        }

        const servers = Object.entries(config.mcpServers);

        // Categorize servers
        const categories = {
          'Core Development': ['filesystem', 'git', 'github'],
          'Knowledge & Memory': ['memory'],
          'Web & Content': ['fetch', 'brave', 'puppeteer'],
          'Collaboration': ['slack', 'google-drive'],
          'Database': ['postgres', 'sqlite'],
          'Utilities': ['time', 'sequential_thinking'],
        };

        console.log(chalk.bold.blue('📦 Available MCP Servers by Category:\n'));

        for (const [category, serverNames] of Object.entries(categories)) {
          console.log(chalk.bold.yellow(`  ${category}:`));
          for (const serverName of serverNames) {
            const serverConfig = config.mcpServers[serverName];
            if (serverConfig) {
              const status = serverConfig.enabled
                ? chalk.green('✓ enabled')
                : chalk.gray('○ disabled');
              console.log(`    ${status}  ${chalk.white(serverName)} - ${chalk.gray(serverConfig.description)}`);
            }
          }
          console.log('');
        }

        const { action } = await inquirer.prompt([
          {
            type: 'list',
            name: 'action',
            message: 'What would you like to do?',
            choices: [
              { name: '✓ Enable recommended servers (filesystem, git, memory, fetch, time)', value: 'enable-recommended' },
              { name: '⚙️  Choose servers to enable/disable', value: 'custom' },
              { name: '🔑 Configure API keys and credentials', value: 'configure' },
              { name: '❌ Cancel', value: 'cancel' },
            ],
          },
        ]);

        if (action === 'cancel') {
          console.log(chalk.gray('\nSetup cancelled.\n'));
          return;
        }

        if (action === 'enable-recommended') {
          const recommended = ['filesystem', 'git', 'memory', 'fetch', 'time'];
          for (const serverName of recommended) {
            if (config.mcpServers[serverName]) {
              config.mcpServers[serverName].enabled = true;
            }
          }
          saveMCPConfig(config);
          console.log(chalk.green('\n✅ Enabled recommended servers successfully!\n'));
          console.log(chalk.cyan('💡 Tip: Run `meer mcp status` to verify connections\n'));
          return;
        }

        if (action === 'custom') {
          const { selectedServers } = await inquirer.prompt([
            {
              type: 'checkbox',
              name: 'selectedServers',
              message: 'Select servers to enable (use space to select):',
              choices: servers.map(([name, serverConfig]) => ({
                name: `${name} - ${serverConfig.description}`,
                value: name,
                checked: serverConfig.enabled,
              })),
            },
          ]);

          // Update enabled status
          for (const [name] of servers) {
            config.mcpServers[name].enabled = selectedServers.includes(name);
          }

          saveMCPConfig(config);
          console.log(chalk.green(`\n✅ Updated ${selectedServers.length} server(s) successfully!\n`));
        }

        if (action === 'configure') {
          console.log(chalk.yellow('\n⚠️  API Key Configuration\n'));
          console.log(chalk.gray('Some MCP servers require API keys or credentials.'));
          console.log(chalk.gray('Set these as environment variables in your shell:\n'));

          console.log(chalk.cyan('  GitHub:'));
          console.log(chalk.gray('    export GITHUB_TOKEN="your_github_token"\n'));

          console.log(chalk.cyan('  Brave Search:'));
          console.log(chalk.gray('    export BRAVE_API_KEY="your_brave_api_key"\n'));

          console.log(chalk.cyan('  Slack:'));
          console.log(chalk.gray('    export SLACK_BOT_TOKEN="xoxb-your-token"'));
          console.log(chalk.gray('    export SLACK_TEAM_ID="T01234567"\n'));

          console.log(chalk.cyan('  Google Drive:'));
          console.log(chalk.gray('    export GDRIVE_CLIENT_ID="your_client_id"'));
          console.log(chalk.gray('    export GDRIVE_CLIENT_SECRET="your_client_secret"'));
          console.log(chalk.gray('    export GDRIVE_REDIRECT_URI="http://localhost:8080"\n'));

          console.log(chalk.cyan('  PostgreSQL:'));
          console.log(chalk.gray('    export POSTGRES_CONNECTION_STRING="postgresql://user:pass@localhost/db"\n'));
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

/**
 * Reset MCP configuration to defaults
 */
function createResetCommand(): Command {
  const command = new Command('reset');

  command
    .description('Reset MCP configuration to default settings')
    .option('-f, --force', 'Skip confirmation prompt')
    .action(async (options) => {
      try {
        const inquirer = (await import('inquirer')).default;

        if (!options.force) {
          const { confirm } = await inquirer.prompt([
            {
              type: 'confirm',
              name: 'confirm',
              message: 'Are you sure you want to reset MCP configuration to defaults?',
              default: false,
            },
          ]);

          if (!confirm) {
            console.log(chalk.gray('\nReset cancelled.\n'));
            return;
          }
        }

        const { getDefaultConfig, saveMCPConfig } = await import('../mcp/config.js');
        const defaultConfig = getDefaultConfig();
        saveMCPConfig(defaultConfig);

        console.log(chalk.green('\n✅ MCP configuration reset to defaults successfully!\n'));
        console.log(chalk.cyan('💡 Run `meer mcp setup` to configure servers again\n'));
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
