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
import { OpenAIProvider } from '../providers/openai.js';
import { GeminiProvider } from '../providers/gemini.js';
import { ZaiProvider } from '../providers/zai.js';

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

async function fetchOpenAIModels(apiKey: string): Promise<string[]> {
  try {
    if (!apiKey) throw new Error('No API key');
    const provider = new OpenAIProvider({ apiKey, model: 'temp' });
    const models = await provider.listModels();
    return models.length > 0 ? models.map(m => m.id) : [
      'o3-mini',
      'o1',
      'o1-mini',
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4-turbo',
      'gpt-3.5-turbo'
    ];
  } catch {
    return [
      'o3-mini',
      'o1',
      'o1-mini',
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4-turbo',
      'gpt-3.5-turbo'
    ];
  }
}

async function fetchGeminiModels(apiKey: string): Promise<string[]> {
  try {
    if (!apiKey) throw new Error('No API key');
    const provider = new GeminiProvider({ apiKey, model: 'temp' });
    const models = await provider.listModels();
    return models.length > 0 ? models.map(m => m.id) : [
      'gemini-2.0-flash-exp',
      'gemini-1.5-pro',
      'gemini-1.5-flash'
    ];
  } catch {
    return [
      'gemini-2.0-flash-exp',
      'gemini-1.5-pro',
      'gemini-1.5-flash'
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

async function fetchZaiModels(apiKey: string): Promise<string[]> {
  const fallbackModels = [
    'glm-4',
    'glm-4-plus',
    'glm-4-air',
    'glm-4-airx',
    'glm-4-flash',
    'glm-4v'
  ];

  try {
    if (!apiKey) throw new Error('No API key');
    const provider = new ZaiProvider({ apiKey, model: 'temp' });
    const models = await provider.listModels();
    return models.length > 0
      ? Array.from(new Set(models.map(m => ZaiProvider.normalizeModel(m.id))))
      : fallbackModels;
  } catch {
    return fallbackModels;
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
          name: chalk.cyan('🌊 Meer Managed Provider') + chalk.gray(' - Use Meer subscription (requires Meer login)'),
          value: 'meer'
        },
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
        },
        {
          name: chalk.cyan('⚡ Z.ai') + chalk.gray(' - GLM models (GLM-4, GLM-4-Air) - Chinese AI leader (requires API key)'),
          value: 'zai'
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
    meer: {
      apiUrl: process.env.MEERAI_API_URL || 'https://api.meerai.dev'
    },
    zai: {
      apiKey: '',
      baseURL: 'https://api.z.ai/api/coding/paas/v4'
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

  } else if (provider === 'meer') {
    console.log(chalk.cyan('\n🔑 Meer Provider Setup\n'));
    console.log(chalk.gray('You can authenticate using either:'));
    console.log(chalk.gray('  1. API Key (recommended for automation and scripts)'));
    console.log(chalk.gray('  2. Login flow (interactive authentication)\n'));

    const { authMethod } = await inquirer.prompt([
      {
        type: 'list',
        name: 'authMethod',
        message: 'Choose authentication method:',
        choices: [
          {
            name: chalk.cyan('🔑 API Key') + chalk.gray(' - Generate from https://meerai.dev/dashboard/api-keys'),
            value: 'apikey'
          },
          {
            name: chalk.cyan('👤 Login') + chalk.gray(' - Use device code flow (existing method)'),
            value: 'login'
          }
        ]
      }
    ]);

    if (authMethod === 'apikey') {
      console.log(chalk.yellow('\n💡 To generate an API key:'));
      console.log(chalk.gray('   1. Visit https://meerai.dev/dashboard/api-keys'));
      console.log(chalk.gray('   2. Click "Create API Key"'));
      console.log(chalk.gray('   3. Give it a name (e.g., "My CLI")'));
      console.log(chalk.gray('   4. Copy the generated key (starts with "meer_")\n'));

      const { apiKey } = await inquirer.prompt([
        {
          type: 'password',
          name: 'apiKey',
          message: 'Enter your Meer API key (or press Enter to use MEER_API_KEY env var):',
          mask: '*',
          validate: (input) => {
            if (!input) return true; // Allow empty for env var
            if (!input.startsWith('meer_')) {
              return 'API key should start with "meer_"';
            }
            if (input.length < 20) {
              return 'API key seems too short. Please check and try again.';
            }
            return true;
          }
        }
      ]);

      config.model = 'auto';
      config.meer.apiKey = apiKey || '';

      if (!apiKey && !process.env.MEER_API_KEY) {
        console.log(chalk.yellow('\n⚠️  No API key provided. Set MEER_API_KEY environment variable before using Meer.'));
        console.log(chalk.gray('\n   export MEER_API_KEY=meer_your_key_here\n'));
      } else {
        console.log(chalk.green('\n✅ API key configured successfully!'));
      }

      console.log(chalk.gray('   Authentication: API Key'));
      console.log(chalk.gray('   Requests will use your Meer subscription and quota.'));
      console.log(chalk.blue('\n🔐 Your API key is stored securely in ~/.meer/config.yaml\n'));
    } else {
      // Login flow (existing behavior - user will use `meer login` command)
      config.model = 'auto';
      config.meer.apiKey = '';

      console.log(chalk.green('\n✅ Meer provider configured for login flow!'));
      console.log(chalk.yellow('\n⚡ Next step: Run the following command to authenticate:'));
      console.log(chalk.cyan('   meer login\n'));
      console.log(chalk.gray('   This will guide you through the device code authentication flow.\n'));
    }

  } else if (provider === 'openai') {
    const { apiKey } = await inquirer.prompt([
      {
        type: 'password',
        name: 'apiKey',
        message: 'Enter your OpenAI API key (or press Enter to set via OPENAI_API_KEY env var):',
        mask: '*'
      }
    ]);

    config.openai.apiKey = apiKey || '';

    // Fetch available models dynamically if API key is provided
    let availableModels: string[] = [];
    if (apiKey) {
      console.log(chalk.gray('🔍 Fetching available models from OpenAI...'));
      availableModels = await fetchOpenAIModels(apiKey);
    } else {
      availableModels = await fetchOpenAIModels('');
    }

    // Add annotations to popular models
    const modelChoices = availableModels.map(model => {
      let name = model;
      if (model.includes('o3-mini')) name += ' (fastest reasoning)';
      else if (model.includes('o1-mini')) name += ' (faster reasoning)';
      else if (model.includes('o1') && !model.includes('mini')) name += ' (advanced reasoning)';
      else if (model === 'gpt-4o') name += ' (recommended)';
      else if (model.includes('gpt-4o-mini')) name += ' (faster, cheaper)';
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

    console.log(chalk.green('\n✅ OpenAI configured!'));
    console.log(chalk.gray(`   Model: ${config.model}`));
    if (!apiKey) {
      console.log(chalk.yellow('\n💡 Remember to set your API key:'));
      console.log(chalk.cyan('   export OPENAI_API_KEY=sk-...\n'));
    }

  } else if (provider === 'gemini') {
    const { apiKey } = await inquirer.prompt([
      {
        type: 'password',
        name: 'apiKey',
        message: 'Enter your Gemini API key (or press Enter to set via GEMINI_API_KEY env var):',
        mask: '*'
      }
    ]);

    config.gemini.apiKey = apiKey || '';

    // Fetch available models dynamically if API key is provided
    let availableModels: string[] = [];
    if (apiKey) {
      console.log(chalk.gray('🔍 Fetching available models from Gemini...'));
      availableModels = await fetchGeminiModels(apiKey);
    } else {
      availableModels = await fetchGeminiModels('');
    }

    // Add annotations to popular models
    const modelChoices = availableModels.map(model => {
      let name = model;
      if (model.includes('2.0-flash')) name += ' (recommended)';
      else if (model.includes('1.5-pro')) name += ' (most capable)';
      else if (model.includes('1.5-flash')) name += ' (faster, cheaper)';
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

  } else if (provider === 'zai') {
    const { apiKey } = await inquirer.prompt([
      {
        type: 'password',
        name: 'apiKey',
        message: 'Enter your Z.ai API key (or press Enter to set via ZAI_API_KEY env var):',
        mask: '*'
      }
    ]);

    config.zai.apiKey = apiKey || '';

    // Fetch available models dynamically if API key is provided
    let availableModels: string[] = [];
    if (apiKey) {
      console.log(chalk.gray('🔍 Fetching available models from Z.ai...'));
      availableModels = await fetchZaiModels(apiKey);
    } else {
      availableModels = await fetchZaiModels('');
    }

    // Add annotations to popular models
    const normalizedModels = Array.from(new Set(availableModels.map(model => ZaiProvider.normalizeModel(model))));
    const modelChoices = normalizedModels.map(model => {
      const lower = model.toLowerCase();
      let name = model;
      if (lower === 'glm-4') name += ' (flagship, 200K context, recommended)';
      else if (lower === 'glm-4-plus') name += ' (enhanced capability tier)';
      else if (lower.includes('glm-4-airx')) name += ' (high performance AirX tier)';
      else if (lower.includes('glm-4-air')) name += ' (cost-effective Air tier)';
      else if (lower.includes('glm-4-flash')) name += ' (free tier, fast)';
      else if (lower.includes('glm-4v')) name += ' (vision model)';
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
          message: 'Enter model name (e.g., glm-4, glm-4-air):'
        }
      ]);
      config.model = customModel;
    } else {
      config.model = model;
    }

    console.log(chalk.green('\n✅ Z.ai configured!'));
    console.log(chalk.gray(`   Model: ${config.model}`));
    if (!apiKey) {
      console.log(chalk.yellow('\n💡 Remember to set your API key:'));
      console.log(chalk.cyan('   export ZAI_API_KEY=...\n'));
    }
    console.log(chalk.blue('\n⚡ Z.ai GLM models: Advanced reasoning, coding, and agentic capabilities!'));
    console.log(chalk.gray('   Context: 128K-200K tokens | Pricing: ~$0.2/$1.1 per 1M tokens'));
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
