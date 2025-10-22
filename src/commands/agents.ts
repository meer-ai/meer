import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { existsSync } from 'fs';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { AgentRegistry } from '../agents/registry.js';
import type { SubAgentDefinition, AgentScope } from '../agents/types.js';

export function createAgentsCommand(): Command {
  const command = new Command('agents');

  command
    .description('Manage sub-agents for specialized tasks')
    .action(async () => {
      // Default action: list all agents
      await listAgents();
    });

  // Subcommand: list
  command
    .command('list')
    .description('List all available agents')
    .option('--enabled-only', 'Show only enabled agents')
    .action(async (options: { enabledOnly?: boolean }) => {
      await listAgents(options.enabledOnly);
    });

  // Subcommand: show
  command
    .command('show <name>')
    .description('Show details of a specific agent')
    .action(async (name: string) => {
      await showAgent(name);
    });

  // Subcommand: create
  command
    .command('create')
    .description('Create a new agent interactively')
    .option('--scope <scope>', 'Agent scope: user or project (default: project)', 'project')
    .action(async (options: { scope: string }) => {
      const scope = options.scope as AgentScope;
      if (scope !== 'user' && scope !== 'project') {
        console.error(chalk.red('Error: scope must be either "user" or "project"'));
        process.exit(1);
      }
      await createAgent(scope);
    });

  // Subcommand: edit
  command
    .command('edit <name>')
    .description('Edit an existing agent')
    .action(async (name: string) => {
      await editAgent(name);
    });

  // Subcommand: enable
  command
    .command('enable <name>')
    .description('Enable an agent')
    .action(async (name: string) => {
      await toggleAgent(name, true);
    });

  // Subcommand: disable
  command
    .command('disable <name>')
    .description('Disable an agent')
    .action(async (name: string) => {
      await toggleAgent(name, false);
    });

  // Subcommand: delete
  command
    .command('delete <name>')
    .description('Delete an agent')
    .option('--scope <scope>', 'Agent scope: user or project', 'project')
    .action(async (name: string, options: { scope: string }) => {
      const scope = options.scope as AgentScope;
      await deleteAgent(name, scope);
    });

  return command;
}

// Helper functions

async function listAgents(enabledOnly: boolean = false): Promise<void> {
  const registry = new AgentRegistry();
  await registry.loadAgents();

  const agents = enabledOnly
    ? registry.getEnabledAgents()
    : registry.getAllAgents();

  if (agents.length === 0) {
    console.log(chalk.yellow('No agents found.'));
    console.log(chalk.gray('\nUse "meer agents create" to create a new agent.'));
    return;
  }

  console.log(chalk.bold.blue(`\n📋 Available Agents (${agents.length})\n`));

  for (const agent of agents) {
    const result = registry.getAgentResult(agent.name);
    const scopeLabel = result?.scope === 'project' ? chalk.blue('[project]') : chalk.gray('[user]');
    const statusLabel = agent.enabled ? chalk.green('✓ enabled') : chalk.gray('✗ disabled');

    console.log(chalk.bold(`${agent.name} ${scopeLabel} ${statusLabel}`));
    console.log(chalk.gray(`  ${agent.description}`));

    if (agent.tools && agent.tools.length > 0) {
      console.log(chalk.gray(`  Tools: ${agent.tools.join(', ')}`));
    }

    if (agent.tags && agent.tags.length > 0) {
      console.log(chalk.gray(`  Tags: ${agent.tags.join(', ')}`));
    }

    console.log();
  }
}

async function showAgent(name: string): Promise<void> {
  const registry = new AgentRegistry();
  await registry.loadAgents();

  const result = registry.getAgentResult(name);

  if (!result) {
    console.error(chalk.red(`Agent not found: ${name}`));
    process.exit(1);
  }

  const agent = result.definition;

  console.log(chalk.bold.blue(`\n📄 Agent: ${agent.name}\n`));
  console.log(chalk.bold('Description:'));
  console.log(`  ${agent.description}\n`);

  console.log(chalk.bold('Details:'));
  console.log(`  Scope: ${result.scope}`);
  console.log(`  Enabled: ${agent.enabled ? chalk.green('Yes') : chalk.red('No')}`);
  console.log(`  Model: ${agent.model || 'inherit'}`);
  console.log(`  File: ${result.filePath}`);
  console.log(`  Last Modified: ${result.lastModified.toLocaleString()}\n`);

  if (agent.tools && agent.tools.length > 0) {
    console.log(chalk.bold('Allowed Tools:'));
    agent.tools.forEach(tool => console.log(`  - ${tool}`));
    console.log();
  }

  if (agent.tags && agent.tags.length > 0) {
    console.log(chalk.bold('Tags:'));
    console.log(`  ${agent.tags.join(', ')}\n`);
  }

  if (agent.maxIterations) {
    console.log(chalk.bold('Advanced:'));
    console.log(`  Max Iterations: ${agent.maxIterations}`);
    if (agent.temperature) {
      console.log(`  Temperature: ${agent.temperature}`);
    }
    console.log();
  }

  console.log(chalk.bold('System Prompt:'));
  console.log(chalk.gray(agent.systemPrompt.substring(0, 300) + '...\n'));
}

async function createAgent(scope: AgentScope): Promise<void> {
  console.log(chalk.bold.blue('\n📝 Create New Agent\n'));

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'name',
      message: 'Agent name (lowercase, no spaces):',
      validate: (input: string) => {
        if (!input.match(/^[a-z0-9-]+$/)) {
          return 'Name must be lowercase letters, numbers, and hyphens only';
        }
        return true;
      },
    },
    {
      type: 'input',
      name: 'description',
      message: 'Description:',
      validate: (input: string) => input.length > 0 || 'Description is required',
    },
    {
      type: 'checkbox',
      name: 'tools',
      message: 'Select allowed tools (empty = all tools):',
      choices: [
        { name: 'Read files (read_file, grep, find_files)', value: 'Read' },
        { name: 'Edit files (propose_edit, edit_section)', value: 'Edit' },
        { name: 'Run commands (run_command)', value: 'Bash' },
        { name: 'Web search (google_search, brave_search)', value: 'Web' },
        { name: 'All tools', value: 'all' },
      ],
    },
    {
      type: 'editor',
      name: 'systemPrompt',
      message: 'System prompt (will open editor):',
      default: '# Agent Instructions\n\nYou are a specialized agent focused on...\n\n## Your Responsibilities\n\n1. ...\n',
    },
    {
      type: 'input',
      name: 'tags',
      message: 'Tags (comma-separated, optional):',
    },
  ]);

  // Map tool categories to actual tools
  const toolMap: Record<string, string[]> = {
    Read: ['read_file', 'grep', 'find_files', 'list_files', 'read_many_files'],
    Edit: ['propose_edit', 'edit_section', 'edit_line'],
    Bash: ['run_command'],
    Web: ['google_search', 'brave_search', 'web_fetch'],
  };

  let tools: string[] | undefined = undefined;

  if (answers.tools.length > 0 && !answers.tools.includes('all')) {
    tools = answers.tools.flatMap((t: string) => toolMap[t] || []);
  }

  const definition: SubAgentDefinition = {
    name: answers.name,
    description: answers.description,
    model: 'inherit',
    tools,
    enabled: true,
    systemPrompt: answers.systemPrompt.trim(),
    tags: answers.tags ? answers.tags.split(',').map((t: string) => t.trim()) : undefined,
    version: '1.0.0',
  };

  const registry = new AgentRegistry();

  // Ensure directory exists
  const targetPath = scope === 'project'
    ? join(process.cwd(), '.meer', 'agents')
    : join(homedir(), '.meer', 'agents');

  if (!existsSync(targetPath)) {
    await mkdir(targetPath, { recursive: true });
  }

  await registry.saveAgent(definition, scope);

  console.log(chalk.green(`\n✅ Agent created: ${definition.name} (${scope})`));
  console.log(chalk.gray(`File: ${targetPath}/${definition.name}.md\n`));
}

async function editAgent(name: string): Promise<void> {
  console.log(chalk.yellow('\n⚠️  Agent editing not yet implemented'));
  console.log(chalk.gray(`You can manually edit the agent file for now.\n`));
  console.log(chalk.gray('Use "meer agents show <name>" to find the file location.\n'));
}

async function toggleAgent(name: string, enabled: boolean): Promise<void> {
  const registry = new AgentRegistry();
  await registry.loadAgents();

  const result = registry.getAgentResult(name);

  if (!result) {
    console.error(chalk.red(`Agent not found: ${name}`));
    process.exit(1);
  }

  const definition = { ...result.definition, enabled };
  await registry.saveAgent(definition, result.scope);

  const status = enabled ? chalk.green('enabled') : chalk.gray('disabled');
  console.log(chalk.green(`\n✅ Agent ${status}: ${name}\n`));
}

async function deleteAgent(name: string, scope: AgentScope): Promise<void> {
  const registry = new AgentRegistry();
  await registry.loadAgents();

  const result = registry.getAgentResult(name);

  if (!result) {
    console.error(chalk.red(`Agent not found: ${name}`));
    process.exit(1);
  }

  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: `Delete agent "${name}" from ${scope} scope?`,
      default: false,
    },
  ]);

  if (!confirm) {
    console.log(chalk.yellow('Cancelled'));
    return;
  }

  await registry.deleteAgent(name, scope);
  console.log(chalk.green(`\n✅ Agent deleted: ${name}\n`));
}
