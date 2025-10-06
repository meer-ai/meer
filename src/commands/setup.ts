import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { stringify } from 'yaml';
import { OllamaProvider } from '../providers/ollama.js';
import { AnthropicProvider } from '../providers/anthropic.js';
import { OpenRouterProvider } from '../providers/openrouter.js';

export function createSetupCommand(): Command {
  return new Command('setup')
    .description('Interactive setup wizard for first-time configuration')
    .action(async () => {
      await runSetupWizard();
    });
}

// Helper functions to fetch models dynamically
async function fetchOllamaModels(host: string): Promise<string[]> {
  try {
    const provider = new OllamaProvider({ host, model: 'temp' });
    const models = await provider.listModels();
    return models.length > 0 ? models : ['llama3.2:latest', 'mistral:latest', 'codellama:latest'];
  } catch {
    return ['llama3.2:latest', 'mistral:latest', 'codellama:latest'];
  }
}

async function fetchAnthropicModels(apiKey: string): Promise<string[]> {
  try {
    if (!apiKey) throw new Error('No API key');
    const provider = new AnthropicProvider({ apiKey, model: 'temp' });
    const models = await provider.listModels();
    return models.length > 0 ? models : ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022'];
  } catch {
    return [
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022', 
      'claude-3-opus-20240229',
      'claude-3-sonnet-20240229',
      'claude-3-haiku-20240307'
    ];
  }
}

async function fetchOpenRouterModels(apiKey: string): Promise<string[]> {
  try {
    if (!apiKey) throw new Error('No API key');
    const provider = new OpenRouterProvider({ apiKey, model: 'temp' });
    const models = await provider.listModels();
    return models.length > 0 ? models : ['anthropic/claude-3.5-sonnet', 'openai/gpt-4o'];
  } catch {
    return [
      'anthropic/claude-3.5-sonnet',
      'anthropic/claude-3-opus',
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
      'meta-llama/llama-3.1-405b-instruct',
      'google/gemini-pro-1.5',
      'mistralai/mistral-large'
    ];
  }
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
        },
        {
          name: chalk.cyan('🧠 Anthropic') + chalk.gray(' - Claude models (requires API key)'),
          value: 'anthropic'
        },
        {
          name: chalk.cyan('🌐 OpenRouter') + chalk.gray(' - Access to many models via one API (requires API key)'),
          value: 'openrouter'
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
    },
    anthropic: {
      apiKey: '',
      baseURL: 'https://api.anthropic.com',
      maxTokens: 4096
    },
    openrouter: {
      apiKey: '',
      baseURL: 'https://openrouter.ai/api',
      siteName: 'MeerAI CLI',
      siteUrl: 'https://github.com/anthropics/meer'
    },
    context: {
      embedding: {
        enabled: false,
        dimensions: 256,
        maxFileSize: 200_000
      }
    }
  };

  // Step 2: Provider-specific configuration
  console.log(chalk.bold.yellow('\nStep 2: Configure Provider\n'));

  if (provider === 'ollama') {
    const { ollamaHost } = await inquirer.prompt([
      {
        type: 'input',
        name: 'ollamaHost',
        message: 'Enter Ollama host URL (press Enter for default):',
        default: 'http://127.0.0.1:11434',
        validate: (input) => {
          if (!input) return 'Host URL is required';
          try {
            new URL(input);
            return true;
          } catch {
            return 'Please enter a valid URL (e.g., http://127.0.0.1:11434)';
          }
        }
      }
    ]);

    config.ollama.host = ollamaHost;

    // Fetch available models dynamically
    console.log(chalk.gray('🔍 Fetching available models from Ollama...'));
    const availableModels = await fetchOllamaModels(ollamaHost);
    
    const modelChoices = availableModels.map(model => ({ name: model, value: model }));
    modelChoices.push({ name: 'Custom model...', value: 'custom' });

    const { model } = await inquirer.prompt([
      {
        type: 'list',
        name: 'model',
        message: availableModels.length > 0 ? 
          'Choose from available models:' : 
          'No models found. Choose from common models:',
        choices: modelChoices
      }
    ]);

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
    if (availableModels.length === 0) {
      console.log(chalk.yellow('\n💡 Tip: Make sure you\'ve pulled the model:'));
      console.log(chalk.cyan(`   ollama pull ${config.model}\n`));
    }

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

  } else if (provider === 'anthropic') {
    const { apiKey } = await inquirer.prompt([
      {
        type: 'password',
        name: 'apiKey',
        message: 'Enter your Anthropic API key (or press Enter to set via ANTHROPIC_API_KEY env var):',
        mask: '*'
      }
    ]);

    config.anthropic.apiKey = apiKey || '';

    // Fetch available models dynamically if API key is provided
    let availableModels: string[] = [];
    if (apiKey) {
      console.log(chalk.gray('🔍 Fetching available models from Anthropic...'));
      availableModels = await fetchAnthropicModels(apiKey);
    } else {
      availableModels = await fetchAnthropicModels('');
    }

    const modelChoices = availableModels.map(model => {
      let name = model;
      if (model.includes('sonnet-20241022')) name += ' (recommended)';
      else if (model.includes('haiku')) name += ' (faster, cheaper)';
      else if (model.includes('opus')) name += ' (most capable)';
      return { name, value: model };
    });

    const { model } = await inquirer.prompt([
      {
        type: 'list',
        name: 'model',
        message: 'Choose a model:',
        choices: modelChoices
      }
    ]);

    config.model = model;

    console.log(chalk.green('\n✅ Anthropic configured!'));
    console.log(chalk.gray(`   Model: ${config.model}`));
    if (!apiKey) {
      console.log(chalk.yellow('\n💡 Remember to set your API key:'));
      console.log(chalk.cyan('   export ANTHROPIC_API_KEY=sk-ant-...\n'));
    }

  } else if (provider === 'openrouter') {
    const { apiKey } = await inquirer.prompt([
      {
        type: 'password',
        name: 'apiKey',
        message: 'Enter your OpenRouter API key (or press Enter to set via OPENROUTER_API_KEY env var):',
        mask: '*'
      }
    ]);

    config.openrouter.apiKey = apiKey || '';

    // Fetch available models dynamically if API key is provided
    let availableModels: string[] = [];
    if (apiKey) {
      console.log(chalk.gray('🔍 Fetching available models from OpenRouter...'));
      availableModels = await fetchOpenRouterModels(apiKey);
    } else {
      availableModels = await fetchOpenRouterModels('');
    }

    // Add annotations to popular models
    const modelChoices = availableModels.map(model => {
      let name = model;
      if (model.includes('claude-3.5-sonnet')) name += ' (recommended)';
      else if (model.includes('gpt-4o-mini')) name += ' (fast & cheap)';
      else if (model.includes('llama-3.1-405b')) name += ' (large context)';
      return { name, value: model };
    });
    modelChoices.push({ name: 'Custom model...', value: 'custom' });

    const { model } = await inquirer.prompt([
      {
        type: 'list',
        name: 'model',
        message: 'Choose a model:',
        choices: modelChoices
      }
    ]);

    if (model === 'custom') {
      const { customModel } = await inquirer.prompt([
        {
          type: 'input',
          name: 'customModel',
          message: 'Enter model name (e.g., anthropic/claude-3-haiku):'
        }
      ]);
      config.model = customModel;
    } else {
      config.model = model;
    }

    console.log(chalk.green('\n✅ OpenRouter configured!'));
    console.log(chalk.gray(`   Model: ${config.model}`));
    if (!apiKey) {
      console.log(chalk.yellow('\n💡 Remember to set your API key:'));
      console.log(chalk.cyan('   export OPENROUTER_API_KEY=sk-or-...\n'));
    }
    console.log(chalk.blue('\n🌐 OpenRouter gives you access to many AI models through one API!'));
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

  const { enableEmbeddings } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'enableEmbeddings',
      message:
        'Enable embedding-based context suggestions? (improves retrieval on large projects)',
      default: false
    }
  ]);

  if (enableEmbeddings) {
    const { dimensionsInput } = await inquirer.prompt([
      {
        type: 'input',
        name: 'dimensionsInput',
        message: 'Embedding dimensions (16-1024, higher = more detail, more storage):',
        default: '256',
        validate: (input: string) => {
          const value = Number.parseInt(input, 10);
          if (!Number.isInteger(value) || value < 16 || value > 1024) {
            return 'Please enter an integer between 16 and 1024';
          }
          return true;
        }
      }
    ]);

    const { maxFileSizeInput } = await inquirer.prompt([
      {
        type: 'input',
        name: 'maxFileSizeInput',
        message: 'Maximum file size to embed (bytes):',
        default: '200000',
        validate: (input: string) => {
          const value = Number.parseInt(input, 10);
          if (!Number.isInteger(value) || value <= 0) {
            return 'Please enter a positive integer (e.g., 200000 for ~200KB)';
          }
          return true;
        }
      }
    ]);

    config.context.embedding.enabled = true;
    config.context.embedding.dimensions = Number.parseInt(dimensionsInput, 10);
    config.context.embedding.maxFileSize = Number.parseInt(maxFileSizeInput, 10);
  } else {
    config.context.embedding.enabled = false;
  }

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
  if (config.context.embedding.enabled) {
    console.log(
      chalk.white('   • Embedding cache:') +
        ' ' +
        chalk.cyan('~/.meer/cache/embeddings.json') +
        chalk.gray(' (auto-managed)')
    );
  }
  console.log('');
  console.log(chalk.bold.cyan('🌊 Happy coding with MeerAI!\n'));
}
