/**
 * MCP (Model Context Protocol) Management Commands
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { MCPManager } from '../mcp/manager.js';
import { loadMCPConfig, toggleServer, mcpConfigExists } from '../mcp/config.js';

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
    .addCommand(createStatusCommand());

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
        const spinner = ora(chalk.blue('Checking MCP server status...')).start();

        const manager = MCPManager.getInstance();
        await manager.initialize();

        const servers = manager.getConnectedServers();
        spinner.stop();

        console.log(chalk.bold.blue(`\n📊 MCP Server Status:\n`));

        if (servers.length === 0) {
          console.log(chalk.yellow('  ⚠️  No servers connected'));
          console.log(chalk.gray('  Enable servers with `meer mcp enable <server>`\n'));
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
