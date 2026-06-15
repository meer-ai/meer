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
  addServer,
  removeServer,
  mcpConfigExists,
  saveMCPConfig,
  checkUvxInstalled,
  displayUvxWarning,
  getUvxRequiredServers,
} from '../mcp/config.js';
import type { MCPServerConfig } from '../mcp/types.js';
import { hasMCPAuth, clearMCPAuth } from '../mcp/oauth/provider.js';

const VALID_TRANSPORTS = ['stdio', 'websocket', 'streaming-http'] as const;

/** Whether a positional target should be treated as a remote URL. */
function isUrl(value: string): boolean {
  return /^(https?|wss?):\/\//i.test(value);
}

/**
 * Map user-facing transport names (and common aliases) to the canonical value
 * stored in config. Returns undefined for unrecognized input.
 */
function normalizeTransport(input: string | undefined): MCPServerConfig['transport'] | undefined {
  if (!input) return undefined;
  switch (input.toLowerCase()) {
    case 'stdio':
      return 'stdio';
    case 'ws':
    case 'websocket':
      return 'websocket';
    // The MCP "streamable HTTP" transport — accept the names people actually type.
    case 'http':
    case 'https':
    case 'sse':
    case 'streamable':
    case 'streamable-http':
    case 'streamablehttp':
    case 'streaming-http':
    case 'streaminghttp':
      return 'streaming-http';
    default:
      return undefined;
  }
}

/**
 * Parse repeatable `KEY=VALUE` CLI options into a record.
 * Returns undefined when no pairs were provided so the field is omitted.
 */
function parseKeyValuePairs(pairs: string[] | undefined): Record<string, string> | undefined {
  if (!pairs || pairs.length === 0) {
    return undefined;
  }

  const result: Record<string, string> = {};
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx <= 0) {
      throw new Error(`Invalid KEY=VALUE pair: "${pair}" (expected format KEY=VALUE)`);
    }
    result[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return result;
}

export function createMCPCommand(): Command {
  const command = new Command('mcp');

  command
    .description('Manage MCP (Model Context Protocol) servers and integrations')
    .addCommand(createListCommand())
    .addCommand(createToolsCommand())
    .addCommand(createResourcesCommand())
    .addCommand(createAddCommand())
    .addCommand(createEditCommand())
    .addCommand(createRemoveCommand())
    .addCommand(createLoginCommand())
    .addCommand(createLogoutCommand())
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
            if (serverConfig.oauth) {
              const authState = hasMCPAuth(name)
                ? chalk.green('signed in')
                : chalk.yellow(`not signed in — run \`meer mcp login ${name}\``);
              console.log(`          ${chalk.gray('OAuth:')} ${authState}`);
            }
          } else if (serverConfig.command) {
            const args = serverConfig.args?.join(' ') ?? '';
            const commandLine = args ? `${serverConfig.command} ${args}` : serverConfig.command;
            console.log(`          ${chalk.gray(commandLine)}`);
          }
        }

        console.log('');
      } catch (error) {
        throw error;
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
        await manager.initialize({ force: true });

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
        throw error;
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
        await manager.initialize({ force: true });

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
        throw error;
      }
    });

  return command;
}

/**
 * Add a new MCP server to configuration
 */
function createAddCommand(): Command {
  const command = new Command('add');

  command
    .description('Add a new MCP server to the configuration')
    .argument('<name>', 'Unique name for the server')
    .argument('[target]', 'A URL (remote server) or a command (stdio server)')
    .argument('[args...]', 'Args for the command; use `--` before args that start with a dash')
    .option('-c, --command <command>', 'Command to launch a stdio server (e.g. npx, uvx)')
    .option('-a, --args <args...>', 'Arguments for the command (quote each to preserve spaces)')
    .option('-u, --url <url>', 'URL for a remote (HTTP/WebSocket) server')
    .option('-t, --transport <transport>', `Transport: stdio | http | sse | ws (aliases accepted)`)
    .option('-e, --env <pairs...>', 'Environment variables as KEY=VALUE (supports ${VAR} substitution)')
    .option('-H, --header <pairs...>', 'HTTP headers as KEY=VALUE (remote servers only)')
    .option('-d, --description <description>', 'Human-readable description')
    .option('--timeout <ms>', 'Connection timeout in milliseconds', (v) => parseInt(v, 10))
    .option('--oauth', 'Remote server uses OAuth (sign in later with `meer mcp login`)')
    .option('--scope <scope>', 'OAuth scopes to request, space-separated (implies --oauth)')
    .option('--disabled', 'Add the server but leave it disabled')
    .action(async (name: string, target: string | undefined, positionalArgs: string[], options) => {
      try {
        // Resolve command/url/args from either explicit flags or the positional
        // target (e.g. `meer mcp add supabase https://...` or `... npx -y pkg`).
        const targetIsUrl = target ? isUrl(target) : false;
        const url = options.url ?? (targetIsUrl ? target : undefined);
        const command = options.command ?? (target && !targetIsUrl ? target : undefined);
        const args =
          options.args ?? (positionalArgs && positionalArgs.length > 0 ? positionalArgs : undefined);

        if (url && command) {
          console.log(chalk.red('\n✗ Ambiguous: provide either a URL (remote) or a command (stdio), not both.\n'));
          process.exitCode = 1;
          return;
        }

        if (!command && !url) {
          console.log(chalk.red('\n✗ Provide a target: a URL (remote) or a command (stdio).'));
          console.log(chalk.gray('  e.g. meer mcp add supabase https://mcp.supabase.com/mcp --transport http'));
          console.log(chalk.gray('       meer mcp add fs -- npx -y @modelcontextprotocol/server-filesystem ~/code'));
          console.log(chalk.gray('  (use `--` before command args that start with a dash, like `-y`)\n'));
          process.exitCode = 1;
          return;
        }

        if (url && args) {
          console.log(chalk.red('\n✗ Positional/--args arguments only apply to stdio (command) servers, not URLs.\n'));
          process.exitCode = 1;
          return;
        }

        const transport = normalizeTransport(options.transport);
        if (options.transport && !transport) {
          console.log(
            chalk.red(`\n✗ Invalid transport "${options.transport}". Use one of: stdio, http, sse, ws.\n`)
          );
          process.exitCode = 1;
          return;
        }

        const serverConfig: MCPServerConfig = {
          enabled: !options.disabled,
        };

        if (command) serverConfig.command = command;
        if (args) serverConfig.args = args;
        if (url) serverConfig.url = url;
        if (transport) serverConfig.transport = transport;

        const env = parseKeyValuePairs(options.env);
        if (env) serverConfig.env = env;

        const headers = parseKeyValuePairs(options.header);
        if (headers) serverConfig.headers = headers;

        if (options.description) serverConfig.description = options.description;
        if (typeof options.timeout === 'number' && !Number.isNaN(options.timeout)) {
          serverConfig.timeout = options.timeout;
        }
        if (options.oauth || options.scope) {
          if (!url) {
            console.log(chalk.red('\n✗ --oauth/--scope only apply to remote (URL) servers.\n'));
            process.exitCode = 1;
            return;
          }
          serverConfig.oauth = true;
          if (options.scope) serverConfig.oauthScope = options.scope;
        }

        addServer(name, serverConfig);

        console.log(chalk.green(`\n✓ Added MCP server "${name}"`));
        console.log(
          chalk.gray(`  ${serverConfig.enabled ? 'Enabled' : 'Disabled'} — ${url ?? command}`)
        );
        if (serverConfig.oauth) {
          console.log(chalk.gray(`  Uses OAuth — sign in with \`meer mcp login ${name}\`.`));
        }
        console.log(chalk.gray('  Run `meer mcp status` to verify the connection.\n'));
      } catch (error) {
        console.log(chalk.red(`\n✗ ${error instanceof Error ? error.message : String(error)}\n`));
        process.exitCode = 1;
      }
    });

  return command;
}

/**
 * Edit fields of an existing MCP server in configuration
 */
function createEditCommand(): Command {
  const command = new Command('edit');

  command
    .description('Edit fields of an existing MCP server')
    .argument('<name>', 'Server name to edit')
    .option('-u, --url <url>', 'Set the remote server URL')
    .option('-c, --command <command>', 'Set the stdio command')
    .option('-a, --args <args...>', 'Replace the command arguments')
    .option('-t, --transport <transport>', 'Set transport: stdio | http | sse | ws (aliases accepted)')
    .option('-d, --description <description>', 'Set the description')
    .option('--timeout <ms>', 'Set connection timeout in milliseconds', (v) => parseInt(v, 10))
    .option('--scope <scope>', 'Set OAuth scopes (space-separated); implies --oauth')
    .option('--oauth', 'Mark the server as OAuth-backed')
    .option('--no-oauth', 'Unset the OAuth flag')
    .action(async (name: string, options) => {
      try {
        const config = loadMCPConfig();
        const serverConfig = config.mcpServers[name];
        if (!serverConfig) {
          console.log(chalk.red(`\n✗ Server "${name}" not found in config. See \`meer mcp list\`.\n`));
          process.exitCode = 1;
          return;
        }

        if (options.transport) {
          const transport = normalizeTransport(options.transport);
          if (!transport) {
            console.log(chalk.red(`\n✗ Invalid transport "${options.transport}". Use one of: stdio, http, sse, ws.\n`));
            process.exitCode = 1;
            return;
          }
          serverConfig.transport = transport;
        }

        if (options.url) serverConfig.url = options.url;
        if (options.command) serverConfig.command = options.command;
        if (options.args) serverConfig.args = options.args;
        if (options.description) serverConfig.description = options.description;
        if (typeof options.timeout === 'number' && !Number.isNaN(options.timeout)) {
          serverConfig.timeout = options.timeout;
        }
        if (options.scope !== undefined) {
          if (options.scope === '') {
            // `--scope ""` clears the scope (let the consent screen decide).
            delete serverConfig.oauthScope;
          } else {
            serverConfig.oauthScope = options.scope;
            serverConfig.oauth = true;
          }
        }
        // commander sets options.oauth=false only when --no-oauth is passed.
        if (options.oauth === true) serverConfig.oauth = true;
        if (options.oauth === false) {
          serverConfig.oauth = false;
          delete serverConfig.oauthScope;
        }

        saveMCPConfig(config);

        // Changing scope/OAuth invalidates any client registered under the old
        // settings — clear stored credentials so the next login starts fresh.
        const oauthChanged = options.scope !== undefined || options.oauth !== undefined;
        if (oauthChanged && hasMCPAuth(name)) {
          clearMCPAuth(name);
        }

        console.log(chalk.green(`\n✓ Updated MCP server "${name}"`));
        if (oauthChanged) {
          console.log(chalk.gray(`  Re-run \`meer mcp login ${name}\` to apply OAuth changes.\n`));
        } else {
          console.log('');
        }
      } catch (error) {
        console.log(chalk.red(`\n✗ ${error instanceof Error ? error.message : String(error)}\n`));
        process.exitCode = 1;
      }
    });

  return command;
}

/**
 * Remove an MCP server from configuration
 */
function createRemoveCommand(): Command {
  const command = new Command('remove');

  command
    .description('Remove an MCP server from the configuration')
    .alias('rm')
    .argument('<server>', 'Server name to remove')
    .action(async (serverName: string) => {
      try {
        removeServer(serverName);
        console.log(chalk.green(`\n✓ Removed MCP server "${serverName}"\n`));
      } catch (error) {
        console.log(chalk.red(`\n✗ ${error instanceof Error ? error.message : String(error)}\n`));
        process.exitCode = 1;
      }
    });

  return command;
}

/**
 * Authenticate with a remote MCP server via OAuth
 */
function createLoginCommand(): Command {
  const command = new Command('login');

  command
    .description('Sign in to a remote MCP server that requires OAuth')
    .argument('<server>', 'Server name to authenticate with')
    .action(async (serverName: string) => {
      let activeSpinner: ReturnType<typeof ora> | undefined;
      try {
        const config = loadMCPConfig();
        const serverConfig = config.mcpServers[serverName];

        if (!serverConfig) {
          console.log(chalk.red(`\n✗ Server "${serverName}" not found in config.`));
          console.log(chalk.gray('  Add it first with `meer mcp add`, or see `meer mcp list`.\n'));
          process.exitCode = 1;
          return;
        }

        if (!serverConfig.url) {
          console.log(
            chalk.red(`\n✗ "${serverName}" is a stdio (command) server. OAuth login only applies to remote (url) servers.\n`)
          );
          process.exitCode = 1;
          return;
        }

        const { loginToMCPServer } = await import('../mcp/oauth/login.js');

        console.log(chalk.bold.cyan(`\n🔐 Signing in to MCP server "${serverName}"\n`));
        activeSpinner = ora(chalk.blue('Starting authorization...')).start();

        const result = await loginToMCPServer(serverName, serverConfig, async (authUrl) => {
          activeSpinner?.stop();
          activeSpinner = undefined;
          console.log(chalk.gray('Opening your browser to authorize...\n'));
          try {
            const open = (await import('open')).default;
            await open(authUrl.toString());
            console.log(chalk.green('✓ Browser opened'));
          } catch {
            console.log(chalk.yellow('⚠  Could not open browser automatically'));
          }
          console.log(
            chalk.gray(`\n  If it did not open, visit:\n  ${chalk.blue.underline(authUrl.toString())}\n`)
          );
          activeSpinner = ora(chalk.blue('Waiting for authorization to complete...')).start();
        });
        activeSpinner?.stop();

        // Mark the server as oauth-backed so future connections attach credentials.
        if (!serverConfig.oauth) {
          serverConfig.oauth = true;
          saveMCPConfig(config);
        }

        console.log(chalk.green(`\n✓ Signed in to "${serverName}" (${result.toolCount} tools available)`));
        console.log(chalk.gray('  Run `meer mcp enable ' + serverName + '` if it is not already enabled.\n'));
      } catch (error) {
        activeSpinner?.stop();
        const { humanizeMCPOAuthError } = await import('../mcp/oauth/login.js');
        console.log(chalk.red(`\n✗ Login failed: ${humanizeMCPOAuthError(error)}\n`));
        process.exitCode = 1;
      }
    });

  return command;
}

/**
 * Remove stored OAuth credentials for a server
 */
function createLogoutCommand(): Command {
  const command = new Command('logout');

  command
    .description('Remove stored OAuth credentials for a remote MCP server')
    .argument('<server>', 'Server name to sign out of')
    .action(async (serverName: string) => {
      try {
        const { clearMCPAuth } = await import('../mcp/oauth/provider.js');
        const removed = clearMCPAuth(serverName);
        if (removed) {
          console.log(chalk.green(`\n✓ Signed out of "${serverName}" (credentials removed)\n`));
        } else {
          console.log(chalk.yellow(`\n⚠  No stored credentials found for "${serverName}"\n`));
        }
      } catch (error) {
        console.log(chalk.red(`\n✗ ${error instanceof Error ? error.message : String(error)}\n`));
        process.exitCode = 1;
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
        throw error;
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
        throw error;
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
        throw error;
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
        throw error;
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
        await manager.initialize({ force: true });

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
        throw error;
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
        throw error;
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
        throw error;
      }
    });

  return command;
}
