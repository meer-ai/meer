import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { stringify } from 'yaml';

export function createSetupCommand(): Command {
  return new Command('setup')
    .description('Interactive setup wizard for first-time configuration')
    .action(async () => {
      await runSetupWizard();
    });
}

async function runSetupWizard(): Promise<void> {
  console.clear();

  // Welcome banner
  console.log(chalk.hex('#00B4D8')('        ╔╦╗╔═╗╔═╗╦═╗   ') + chalk.hex('#0077B6')('  ~~~~'));
  console.log(chalk.hex('#0096C7')('        ║║║║╣ ║╣ ╠╦╝   ') + chalk.hex('#00B4D8')(' ~~~~~'));
  console.log(chalk.hex('#0077B6')('        ╩ ╩╚═╝╚═╝╩╚═   ') + chalk.hex('#48CAE4')('~~~~~~'));
  console.log('');
  console.log(chalk.bold.cyan('🌊 Welcome to MeerAI Setup!\n'));
  console.log(chalk.gray('Let\'s get you configured to use AI models in your terminal.\n'));

  const configPath = join(homedir(), '.meer', 'config.yaml');

  // Check if config already exists
  if (existsSync(configPath)) {
    const { overwrite } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'overwrite',
        message: 'Configuration already exists. Do you want to reconfigure?',
        default: false
      }
    ]);

    if (!overwrite) {
      console.log(chalk.gray('\nSetup cancelled. Your existing configuration is unchanged.\n'));
      return;
    }
  }

  // Step 1: Choose provider
  console.log(chalk.bold.yellow('Step 1: Choose Your AI Provider\n'));

  const { provider } = await inquirer.prompt([
    {
      type: 'list',
      name: 'provider',
      message: 'Which AI provider would you like to use?',
      choices: [
        {
          name: chalk.cyan('🦙 Ollama') + chalk.gray(' - Local, private, free (requires Ollama installed)'),
          value: 'ollama'
        },
        {
          name: chalk.cyan('🤖 OpenAI') + chalk.gray(' - GPT-4, GPT-3.5 (requires API key)'),
          value: 'openai'
        },
        {
          name: chalk.cyan('✨ Google Gemini') + chalk.gray(' - Gemini models (requires API key)'),
          value: 'gemini'
        }
      ]
    }
  ]);

  let config: any = {
    provider,
    temperature: 0.7,
    ollama: {
      host: 'http://127.0.0.1:11434',
      options: {}
    },
    openai: {
      apiKey: '',
      baseURL: 'https://api.openai.com/v1',
      organization: ''
    },
    gemini: {
      apiKey: ''
    }
  };

  // Step 2: Provider-specific configuration
  console.log(chalk.bold.yellow('\nStep 2: Configure Provider\n'));

  if (provider === 'ollama') {
    const { useCustomHost, ollamaHost, model } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'useCustomHost',
        message: 'Are you using Ollama on a custom host/port?',
        default: false
      },
      {
        type: 'input',
        name: 'ollamaHost',
        message: 'Enter Ollama host URL:',
        default: 'http://127.0.0.1:11434',
        when: (answers) => answers.useCustomHost
      },
      {
        type: 'list',
        name: 'model',
        message: 'Choose a model (make sure it\'s pulled with "ollama pull"):',
        choices: [
          { name: 'mistral:7b-instruct', value: 'mistral:7b-instruct' },
          { name: 'llama3.2:3b', value: 'llama3.2:3b' },
          { name: 'phi3:3.8b', value: 'phi3:3.8b' },
          { name: 'qwen2.5:3b-instruct', value: 'qwen2.5:3b-instruct' },
          { name: 'codellama:7b', value: 'codellama:7b' },
          { name: 'Custom model...', value: 'custom' }
        ]
      }
    ]);

    if (useCustomHost && ollamaHost) {
      config.ollama.host = ollamaHost;
    }

    if (model === 'custom') {
      const { customModel } = await inquirer.prompt([
        {
          type: 'input',
          name: 'customModel',
          message: 'Enter model name (e.g., deepseek-coder:6.7b):'
        }
      ]);
      config.model = customModel;
    } else {
      config.model = model;
    }

    console.log(chalk.green('\n✅ Ollama configured!'));
    console.log(chalk.gray(`   Model: ${config.model}`));
    console.log(chalk.gray(`   Host: ${config.ollama.host}`));
    console.log(chalk.yellow('\n💡 Tip: Make sure you\'ve pulled the model:'));
    console.log(chalk.cyan(`   ollama pull ${config.model}\n`));

  } else if (provider === 'openai') {
    const { apiKey, model } = await inquirer.prompt([
      {
        type: 'password',
        name: 'apiKey',
        message: 'Enter your OpenAI API key (or press Enter to set via OPENAI_API_KEY env var):',
        mask: '*'
      },
      {
        type: 'list',
        name: 'model',
        message: 'Choose a model:',
        choices: [
          { name: 'gpt-4o (recommended)', value: 'gpt-4o' },
          { name: 'gpt-4o-mini (faster, cheaper)', value: 'gpt-4o-mini' },
          { name: 'gpt-4-turbo', value: 'gpt-4-turbo' },
          { name: 'gpt-3.5-turbo', value: 'gpt-3.5-turbo' }
        ]
      }
    ]);

    config.openai.apiKey = apiKey || '';
    config.model = model;

    console.log(chalk.green('\n✅ OpenAI configured!'));
    console.log(chalk.gray(`   Model: ${config.model}`));
    if (!apiKey) {
      console.log(chalk.yellow('\n💡 Remember to set your API key:'));
      console.log(chalk.cyan('   export OPENAI_API_KEY=sk-...\n'));
    }

  } else if (provider === 'gemini') {
    const { apiKey, model } = await inquirer.prompt([
      {
        type: 'password',
        name: 'apiKey',
        message: 'Enter your Gemini API key (or press Enter to set via GEMINI_API_KEY env var):',
        mask: '*'
      },
      {
        type: 'list',
        name: 'model',
        message: 'Choose a model:',
        choices: [
          { name: 'gemini-2.0-flash-exp (recommended)', value: 'gemini-2.0-flash-exp' },
          { name: 'gemini-1.5-pro', value: 'gemini-1.5-pro' },
          { name: 'gemini-1.5-flash', value: 'gemini-1.5-flash' }
        ]
      }
    ]);

    config.gemini.apiKey = apiKey || '';
    config.model = model;

    console.log(chalk.green('\n✅ Gemini configured!'));
    console.log(chalk.gray(`   Model: ${config.model}`));
    if (!apiKey) {
      console.log(chalk.yellow('\n💡 Remember to set your API key:'));
      console.log(chalk.cyan('   export GEMINI_API_KEY=...\n'));
    }
  }

  // Step 3: Additional preferences
  console.log(chalk.bold.yellow('\nStep 3: Additional Preferences\n'));

  const { temperature } = await inquirer.prompt([
    {
      type: 'list',
      name: 'temperature',
      message: 'Choose creativity level (temperature):',
      choices: [
        { name: 'Precise (0.2) - More deterministic, focused responses', value: 0.2 },
        { name: 'Balanced (0.7) - Good mix of creativity and accuracy', value: 0.7 },
        { name: 'Creative (1.0) - More varied, creative responses', value: 1.0 }
      ]
    }
  ]);

  config.temperature = temperature;

  // Save configuration
  const configDir = join(homedir(), '.meer');
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  writeFileSync(configPath, stringify(config), 'utf-8');

  // Success message
  console.log(chalk.bold.green('\n✨ Setup Complete!\n'));
  console.log(chalk.gray('Your configuration has been saved to:'));
  console.log(chalk.cyan(`   ${configPath}\n`));
  console.log(chalk.bold.yellow('🚀 Quick Start:\n'));
  console.log(chalk.white('   • Try the chat:') + ' ' + chalk.cyan('meer'));
  console.log(chalk.white('   • Ask a question:') + ' ' + chalk.cyan('meer ask "What does this code do?"'));
  console.log(chalk.white('   • Get help:') + ' ' + chalk.cyan('meer --help'));
  console.log('');
  console.log(chalk.bold.cyan('🌊 Happy coding with MeerAI!\n'));
}
