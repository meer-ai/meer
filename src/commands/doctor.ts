/**
 * System Health Check Command
 *
 * Verifies that all dependencies and configurations are correctly set up
 */

import { Command } from 'commander';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import chalk from 'chalk';
import { loadConfig, configExists } from '../config.js';
import { MCPManager } from '../mcp/manager.js';

export function createDoctorCommand(): Command {
  return new Command('doctor')
    .description('Run system health checks and diagnostics')
    .action(async () => {
      await runDoctor();
    });
}

export interface HealthCheckResult {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  message: string;
  fix?: string;
}

export async function runDoctor(): Promise<void> {
  console.log(chalk.bold.cyan('\n🏥 Meer CLI System Health Check\n'));
  console.log(chalk.gray('Running diagnostics...\n'));

  const results: HealthCheckResult[] = [];

  // Check Node.js version
  results.push(await checkNodeVersion());

  // Check Git installation
  results.push(await checkGit());

  // Check Python installation
  results.push(await checkPython());

  // Check config file
  results.push(await checkConfig());

  // Check provider API keys
  results.push(...await checkProviderKeys());

  // Check MCP servers
  results.push(...await checkMCPServers());

  // Run smoke tests
  results.push(...await runSmokeTests());

  // Display results
  console.log(chalk.bold('\n📊 Health Check Results:\n'));

  let passCount = 0;
  let warnCount = 0;
  let failCount = 0;

  for (const result of results) {
    let icon: string;
    let color: typeof chalk.green;

    if (result.status === 'pass') {
      icon = '✅';
      color = chalk.green;
      passCount++;
    } else if (result.status === 'warn') {
      icon = '⚠️ ';
      color = chalk.yellow;
      warnCount++;
    } else {
      icon = '❌';
      color = chalk.red;
      failCount++;
    }

    console.log(color(`${icon} ${result.name}`));
    console.log(color(`   ${result.message}`));

    if (result.fix) {
      console.log(chalk.gray(`   Fix: ${result.fix}`));
    }
    console.log('');
  }

  // Summary
  console.log(chalk.bold('\n📈 Summary:\n'));
  console.log(chalk.green(`✅ Passed: ${passCount}`));
  console.log(chalk.yellow(`⚠️  Warnings: ${warnCount}`));
  console.log(chalk.red(`❌ Failed: ${failCount}`));

  if (failCount > 0) {
    console.log(chalk.red('\n❌ Some critical issues found. Please fix them before using Meer CLI.'));
    process.exit(1);
  } else if (warnCount > 0) {
    console.log(chalk.yellow('\n⚠️  Some warnings found. Meer CLI should work, but consider addressing them.'));
  } else {
    console.log(chalk.green('\n✅ All checks passed! Meer CLI is ready to use.'));
  }
}

async function checkNodeVersion(): Promise<HealthCheckResult> {
  try {
    const version = process.version;
    const major = parseInt(version.slice(1).split('.')[0]);

    if (major >= 18) {
      return {
        name: 'Node.js Version',
        status: 'pass',
        message: `Node.js ${version} (>= 18.0.0)`,
      };
    } else {
      return {
        name: 'Node.js Version',
        status: 'fail',
        message: `Node.js ${version} (< 18.0.0)`,
        fix: 'Install Node.js >= 18.0.0 from https://nodejs.org',
      };
    }
  } catch (error) {
    return {
      name: 'Node.js Version',
      status: 'fail',
      message: 'Could not determine Node.js version',
      fix: 'Install Node.js from https://nodejs.org',
    };
  }
}

async function checkGit(): Promise<HealthCheckResult> {
  try {
    const version = execSync('git --version', { encoding: 'utf-8', stdio: 'pipe' }).trim();
    return {
      name: 'Git Installation',
      status: 'pass',
      message: version,
    };
  } catch (error) {
    return {
      name: 'Git Installation',
      status: 'warn',
      message: 'Git not found',
      fix: 'Install Git from https://git-scm.com (required for rollback and version control features)',
    };
  }
}

async function checkPython(): Promise<HealthCheckResult> {
  try {
    // Try python3 first, then python
    let version: string;
    try {
      version = execSync('python3 --version', { encoding: 'utf-8', stdio: 'pipe' }).trim();
    } catch {
      version = execSync('python --version', { encoding: 'utf-8', stdio: 'pipe' }).trim();
    }

    return {
      name: 'Python Installation',
      status: 'pass',
      message: version,
    };
  } catch (error) {
    return {
      name: 'Python Installation',
      status: 'warn',
      message: 'Python not found',
      fix: 'Install Python >= 3.8 from https://python.org (required for MCP servers)',
    };
  }
}

async function checkConfig(): Promise<HealthCheckResult> {
  if (!configExists()) {
    return {
      name: 'Configuration File',
      status: 'warn',
      message: 'Config file not found at ~/.meer/config.yaml',
      fix: 'Run "meer setup" to create a config file',
    };
  }

  try {
    const config = loadConfig();
    return {
      name: 'Configuration File',
      status: 'pass',
      message: `Provider: ${config.providerType}, Model: ${config.model}`,
    };
  } catch (error) {
    return {
      name: 'Configuration File',
      status: 'fail',
      message: `Invalid config file: ${error instanceof Error ? error.message : String(error)}`,
      fix: 'Run "meer setup" to recreate the config file',
    };
  }
}

async function checkProviderKeys(): Promise<HealthCheckResult[]> {
  const results: HealthCheckResult[] = [];

  if (!configExists()) {
    return results;
  }

  try {
    const config = loadConfig();

    // Check for provider-specific API keys
    const checks = [
      {
        name: 'OpenAI API Key',
        env: 'OPENAI_API_KEY',
        provider: 'openai',
      },
      {
        name: 'Anthropic API Key',
        env: 'ANTHROPIC_API_KEY',
        provider: 'anthropic',
      },
      {
        name: 'Gemini API Key',
        env: 'GEMINI_API_KEY',
        provider: 'gemini',
      },
      {
        name: 'OpenRouter API Key',
        env: 'OPENROUTER_API_KEY',
        provider: 'openrouter',
      },
      {
        name: 'Z.ai API Key',
        env: 'ZAI_API_KEY',
        provider: 'zaiCodingPlan',
      },
      {
        name: 'Meer API Key',
        env: 'MEER_API_KEY',
        provider: 'meer',
      },
    ];

    for (const check of checks) {
      const isActiveProvider = config.providerType === check.provider;
      const hasKey = !!process.env[check.env];

      if (isActiveProvider) {
        if (hasKey) {
          results.push({
            name: check.name,
            status: 'pass',
            message: `${check.env} is set`,
          });
        } else {
          results.push({
            name: check.name,
            status: 'fail',
            message: `${check.env} not set (required for ${check.provider})`,
            fix: `Set ${check.env} environment variable or run "meer setup"`,
          });
        }
      }
    }
  } catch (error) {
    // Config loading error already handled in checkConfig
  }

  return results;
}

async function checkMCPServers(): Promise<HealthCheckResult[]> {
  const results: HealthCheckResult[] = [];
  const mcpConfigPath = join(homedir(), '.meer', 'mcp.json');

  if (!existsSync(mcpConfigPath)) {
    results.push({
      name: 'MCP Configuration',
      status: 'warn',
      message: 'MCP config file not found',
      fix: 'MCP servers are optional but recommended for advanced features',
    });
    return results;
  }

  try {
    const mcpManager = MCPManager.getInstance();
    await mcpManager.initialize();

    const connectedServers = mcpManager.getConnectedServers();
    const tools = mcpManager.listAllTools();

    if (connectedServers.length === 0) {
      results.push({
        name: 'MCP Servers',
        status: 'warn',
        message: 'No MCP servers connected',
        fix: 'Configure MCP servers in ~/.meer/mcp.json or check server availability',
      });
    } else {
      results.push({
        name: 'MCP Servers',
        status: 'pass',
        message: `${connectedServers.length} server(s) connected, ${tools.length} tool(s) available`,
      });
    }
  } catch (error) {
    results.push({
      name: 'MCP Servers',
      status: 'warn',
      message: `MCP initialization error: ${error instanceof Error ? error.message : String(error)}`,
      fix: 'Check MCP configuration in ~/.meer/mcp.json',
    });
  }

  return results;
}

async function runSmokeTests(): Promise<HealthCheckResult[]> {
  const results: HealthCheckResult[] = [];

  // Test 1: Check if working directory is writable
  try {
    const testFile = join(process.cwd(), '.meer-test-' + Date.now());
    const fs = await import('fs/promises');
    await fs.writeFile(testFile, 'test', 'utf-8');
    await fs.unlink(testFile);

    results.push({
      name: 'Working Directory Write Access',
      status: 'pass',
      message: 'Can write to current directory',
    });
  } catch (error) {
    results.push({
      name: 'Working Directory Write Access',
      status: 'fail',
      message: 'Cannot write to current directory',
      fix: 'Run Meer CLI from a directory with write permissions',
    });
  }

  // Test 2: Check if config directory is writable
  try {
    const configDir = join(homedir(), '.meer');
    const testFile = join(configDir, '.meer-test-' + Date.now());
    const fs = await import('fs/promises');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(testFile, 'test', 'utf-8');
    await fs.unlink(testFile);

    results.push({
      name: 'Config Directory Write Access',
      status: 'pass',
      message: 'Can write to ~/.meer directory',
    });
  } catch (error) {
    results.push({
      name: 'Config Directory Write Access',
      status: 'fail',
      message: 'Cannot write to ~/.meer directory',
      fix: 'Ensure ~/.meer directory has write permissions',
    });
  }

  return results;
}
