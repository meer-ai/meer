import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { stringify } from 'yaml';
import { OllamaProvider } from '@meer-ai/ai/providers/ollama.js';
import { AnthropicProvider } from '@meer-ai/ai/providers/anthropic.js';
import { OpenRouterProvider } from '@meer-ai/ai/providers/openrouter.js';
import { OpenAIProvider } from '@meer-ai/ai/providers/openai.js';
import { GeminiProvider } from '@meer-ai/ai/providers/gemini.js';
import {
  ZaiCodingPlanProvider,
  ZaiCreditProvider,
  normalizeZaiModel,
} from '@meer-ai/ai/providers/zai.js';
import {
  OPENCODE_ZEN_MODELS,
  OPENCODE_GO_MODELS,
  DEFAULT_OPENCODE_ZEN_MODEL,
  DEFAULT_OPENCODE_GO_MODEL,
} from '@meer-ai/ai/providers/opencode.js';
import { DEEPSEEK_MODELS, DEFAULT_DEEPSEEK_MODEL } from '@meer-ai/ai/providers/deepseek.js';
import { TOGETHER_MODELS, DEFAULT_TOGETHER_MODEL } from '@meer-ai/ai/providers/together.js';

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

type ZaiVariant = 'coding-plan' | 'credit';

const ZAI_CODING_PLAN_SUPPORTED_MODELS = [
  'glm-4.6',
  'glm-4.5',
  'glm-4.5-air',
  'glm-4.5-flash',
  'glm-4.5v'
] as const;

const ZAI_CODING_PLAN_MODEL_SET = new Set(
  ZAI_CODING_PLAN_SUPPORTED_MODELS.map(model => model.toLowerCase())
);

const ZAI_CODING_PLAN_DESCRIPTIONS: Record<string, string> = {
  'glm-4.6': ' (flagship, 200K context, recommended)',
  'glm-4.5': ' (balanced, general coding)',
  'glm-4.5-air': ' (cost-effective Air tier)',
  'glm-4.5-flash': ' (flash tier, fastest responses)',
  'glm-4.5v': ' (vision enabled)',
};

const ZAI_CREDIT_FALLBACK_MODELS = [
  'glm-4',
  'glm-4-plus',
  'glm-4-air',
  'glm-4-airx',
  'glm-4-flash',
  'glm-4v'
] as const;

const ZAI_CREDIT_DESCRIPTIONS: Record<string, string> = {
  'glm-4': ' (flagship, 200K context, recommended)',
  'glm-4-plus': ' (enhanced capability tier)',
  'glm-4-airx': ' (high performance AirX tier)',
  'glm-4-air': ' (cost-effective Air tier)',
  'glm-4-flash': ' (free tier, fast)',
  'glm-4v': ' (vision model)',
};

async function fetchZaiModels(apiKey: string, variant: ZaiVariant): Promise<string[]> {
  const fallbackModels =
    variant === 'coding-plan'
      ? Array.from(ZAI_CODING_PLAN_SUPPORTED_MODELS)
      : Array.from(ZAI_CREDIT_FALLBACK_MODELS);

  try {
    if (!apiKey) throw new Error('No API key');
    const provider =
      variant === 'credit'
        ? new ZaiCreditProvider({ apiKey, model: 'temp' })
        : new ZaiCodingPlanProvider({ apiKey, model: 'temp' });
    const models = await provider.listModels();
    if (models.length === 0) {
      return fallbackModels;
    }

    const normalized = Array.from(new Set(models.map(m => normalizeZaiModel(m.id))));

    if (variant === 'coding-plan') {
      const filtered = normalized.filter(model => ZAI_CODING_PLAN_MODEL_SET.has(model.toLowerCase()));
      return filtered.length > 0 ? filtered : fallbackModels;
    }

    return normalized;
  } catch {
    return fallbackModels;
  }
}

export async function runSetupWizard(): Promise<void> {
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
          name: chalk.cyan('🌊 Meer Managed Provider') + chalk.gray(' - Use Meer Starter/Pro hosted plans (requires Meer login)'),
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
          name: chalk.cyan('🐳 DeepSeek') + chalk.gray(' - DeepSeek Chat / Reasoner, V4 (requires DEEPSEEK_API_KEY)'),
          value: 'deepseek'
        },
        {
          name: chalk.cyan('🤝 Together AI') + chalk.gray(' - Llama, Qwen, DeepSeek & more (requires TOGETHER_API_KEY)'),
          value: 'together'
        },
        {
          name: chalk.cyan('⚡ Z.ai Coding Plan') + chalk.gray(' - DevPack subscription (coding bundle, integrates with Cline/Claude Code)'),
          value: 'zaiCodingPlan'
        },
        {
          name: chalk.cyan('⚡ Z.ai Credit (PAYG)') + chalk.gray(' - Standard pay-as-you-go API for GLM models'),
          value: 'zaiCredit'
        },
        {
          name: chalk.cyan('🔮 OpenCode Zen') + chalk.gray(' - Premium plan: Claude, GPT-5, DeepSeek, Gemini & more (OPENCODE_API_KEY)'),
          value: 'opencodeZen'
        },
        {
          name: chalk.cyan('⚡ OpenCode Go') + chalk.gray(' - Go plan: DeepSeek, Kimi, Qwen, GLM & more (OPENCODE_API_KEY)'),
          value: 'opencodeGo'
        },
        {
          name: chalk.cyan('💬 ChatGPT') + chalk.gray(' - Use your ChatGPT Plus/Pro account (no API key, OAuth login)'),
          value: 'chatgpt'
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
      maxTokens: 8192
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
      baseURL: 'https://api.z.ai/api/coding/paas/v4',
      embeddingBaseURL: 'https://api.z.ai/api/paas/v4'
    },
    zaiCodingPlan: {
      apiKey: '',
      baseURL: 'https://api.z.ai/api/coding/paas/v4',
      embeddingBaseURL: 'https://api.z.ai/api/paas/v4'
    },
    zaiCredit: {
      apiKey: '',
      baseURL: 'https://api.z.ai/api/paas/v4',
      embeddingBaseURL: 'https://api.z.ai/api/paas/v4'
    },
    opencodeZen: {
      apiKey: '',
    },
    opencodeGo: {
      apiKey: '',
    },
    deepseek: {
      apiKey: '',
    },
    together: {
      apiKey: '',
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
      console.log(chalk.gray('   Requests will use your Meer plan and rolling cost limits.'));
      console.log(chalk.blue('\n🔐 Your API key is stored securely in ~/.meer/config.yaml\n'));
    } else {
      // Login flow (existing behavior - user will use `meer login` command)
      config.model = 'auto';
      config.meer.apiKey = '';

      console.log(chalk.green('\n✅ Meer provider configured for login flow!'));
      console.log(chalk.yellow('\n⚡ Starting browser/device login now...\n'));

      const { createLoginCommand } = await import('./login.js');
      await createLoginCommand().parseAsync(['login'], { from: 'user' });
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

  } else if (provider === 'zaiCodingPlan' || provider === 'zaiCredit') {
    const isCodingPlan = provider === 'zaiCodingPlan';
    const providerLabel = isCodingPlan ? 'Z.ai Coding Plan' : 'Z.ai Credit (PAYG)';
    const targetConfig = isCodingPlan ? config.zaiCodingPlan : config.zaiCredit;
    const variant: ZaiVariant = isCodingPlan ? 'coding-plan' : 'credit';

    const { apiKey } = await inquirer.prompt([
      {
        type: 'password',
        name: 'apiKey',
        message: `Enter your ${providerLabel} API key (or press Enter to use ZAI_API_KEY env var):`,
        mask: '*'
      }
    ]);

    targetConfig.apiKey = apiKey || '';

    // Fetch available models dynamically if API key is provided
    let availableModels: string[] = [];
    if (apiKey) {
      console.log(chalk.gray(`🔍 Fetching available models from ${providerLabel}...`));
      availableModels = await fetchZaiModels(apiKey, variant);
    } else {
      availableModels = await fetchZaiModels('', variant);
    }

    // Add annotations to popular models
    const normalizedModels = Array.from(new Set(availableModels.map(model => normalizeZaiModel(model))));
    const modelChoices = normalizedModels.map(model => {
      const lower = model.toLowerCase();
      let name = model;
      if (variant === 'coding-plan') {
        const description = ZAI_CODING_PLAN_DESCRIPTIONS[lower];
        if (description) name += description;
      } else {
        const description = ZAI_CREDIT_DESCRIPTIONS[lower];
        if (description) name += description;
      }
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
          message:
            variant === 'coding-plan'
              ? 'Enter model name (e.g., glm-4.6, glm-4.5-air):'
              : 'Enter model name (e.g., glm-4, glm-4-air):'
        }
      ]);
      config.model = customModel;
    } else {
      config.model = model;
    }

    console.log(chalk.green(`
✅ ${providerLabel} configured!`));
    console.log(chalk.gray(`   Model: ${config.model}`));
    if (!apiKey) {
      console.log(chalk.yellow('\n💡 Remember to set your API key:'));
      console.log(chalk.cyan('   export ZAI_API_KEY=...\n'));
    }
    console.log(chalk.blue(`
⚡ ${providerLabel}: Advanced reasoning, coding, and agentic capabilities with GLM models!`));
    console.log(chalk.gray('   Context: 128K-200K tokens | Pricing: ~$0.2/$1.1 per 1M tokens'));
  } else if (provider === 'opencodeZen' || provider === 'opencodeGo') {
    const isZen = provider === 'opencodeZen';
    const label = isZen ? 'OpenCode Zen' : 'OpenCode Go';
    const models = isZen ? OPENCODE_ZEN_MODELS : OPENCODE_GO_MODELS;
    const defaultModel = isZen ? DEFAULT_OPENCODE_ZEN_MODEL : DEFAULT_OPENCODE_GO_MODEL;

    const { apiKey } = await inquirer.prompt([
      {
        type: 'password',
        name: 'apiKey',
        message: `Enter your ${label} API key (or press Enter to use OPENCODE_API_KEY env var):`,
        mask: '*'
      }
    ]);

    if (isZen) {
      config.opencodeZen = { apiKey: apiKey || '' };
    } else {
      config.opencodeGo = { apiKey: apiKey || '' };
    }

    const modelChoices = models.map(m => ({ name: m.name, value: m.id }));
    modelChoices.push({ name: 'Custom model...', value: 'custom' });

    const { model } = await inquirer.prompt([
      {
        type: 'list',
        name: 'model',
        message: 'Choose a model:',
        choices: modelChoices,
        default: defaultModel,
      }
    ]);

    if (model === 'custom') {
      const { customModel } = await inquirer.prompt([
        {
          type: 'input',
          name: 'customModel',
          message: `Enter model ID (e.g., ${defaultModel}):`,
        }
      ]);
      config.model = customModel || defaultModel;
    } else {
      config.model = model;
    }

    console.log(chalk.green(`\n✅ ${label} configured!`));
    console.log(chalk.gray(`   Model: ${config.model}`));
    if (!apiKey) {
      console.log(chalk.yellow('\n💡 Remember to set your API key:'));
      console.log(chalk.cyan('   export OPENCODE_API_KEY=your-key-here\n'));
    }
    if (isZen) {
      console.log(chalk.blue('\n🔮 OpenCode Zen: Access Claude, GPT-5, DeepSeek, Gemini & more via a single key!'));
      console.log(chalk.gray('   Note: Claude models use the Anthropic API format — for best Claude support,'));
      console.log(chalk.gray('   use the Anthropic provider with baseURL: https://opencode.ai/zen'));
    } else {
      console.log(chalk.blue('\n⚡ OpenCode Go: Fast, affordable models — DeepSeek, Kimi, Qwen, GLM & more!'));
    }
  } else if (provider === 'deepseek' || provider === 'together') {
    const isDeepSeek = provider === 'deepseek';
    const label = isDeepSeek ? 'DeepSeek' : 'Together AI';
    const envVar = isDeepSeek ? 'DEEPSEEK_API_KEY' : 'TOGETHER_API_KEY';
    const models = isDeepSeek ? DEEPSEEK_MODELS : TOGETHER_MODELS;
    const defaultModel = isDeepSeek ? DEFAULT_DEEPSEEK_MODEL : DEFAULT_TOGETHER_MODEL;

    const { apiKey } = await inquirer.prompt([
      {
        type: 'password',
        name: 'apiKey',
        message: `Enter your ${label} API key (or press Enter to use ${envVar} env var):`,
        mask: '*'
      }
    ]);

    if (isDeepSeek) {
      config.deepseek = { apiKey: apiKey || '' };
    } else {
      config.together = { apiKey: apiKey || '' };
    }

    const modelChoices = models.map(m => ({ name: m.name, value: m.id }));
    modelChoices.push({ name: 'Custom model...', value: 'custom' });

    const { model } = await inquirer.prompt([
      {
        type: 'list',
        name: 'model',
        message: 'Choose a model:',
        choices: modelChoices,
        default: defaultModel,
      }
    ]);

    if (model === 'custom') {
      const { customModel } = await inquirer.prompt([
        {
          type: 'input',
          name: 'customModel',
          message: `Enter model ID (e.g., ${defaultModel}):`,
        }
      ]);
      config.model = customModel || defaultModel;
    } else {
      config.model = model;
    }

    console.log(chalk.green(`\n✅ ${label} configured!`));
    console.log(chalk.gray(`   Model: ${config.model}`));
    if (!apiKey) {
      console.log(chalk.yellow('\n💡 Remember to set your API key:'));
      console.log(chalk.cyan(`   export ${envVar}=your-key-here\n`));
    }
  } else if (provider === 'chatgpt') {
    console.log(chalk.cyan('\n💬 ChatGPT Setup\n'));
    console.log(chalk.gray('Meer will authenticate with your ChatGPT account using OAuth.'));
    console.log(chalk.gray('No API key needed — just your ChatGPT Plus or Pro subscription.\n'));

    const { AuthStorage } = await import('@meer-ai/core/auth/storage.js');
    const authStorage = new AuthStorage();

    if (authStorage.isChatGPTAuthenticated()) {
      const creds = authStorage.getChatGPTCredentials()!;
      console.log(chalk.green('✅ Already logged in to ChatGPT.'));
      console.log(chalk.dim(`   Account ID: ${creds.accountId}\n`));
    } else {
      const { loginMethod } = await inquirer.prompt([
        {
          type: 'list',
          name: 'loginMethod',
          message: 'Choose login method:',
          choices: [
            {
              name: chalk.cyan('🌐 Browser') + chalk.gray(' - Opens chatgpt.com in your browser (recommended)'),
              value: 'browser'
            },
            {
              name: chalk.cyan('📟 Device code') + chalk.gray(' - Enter a code on chatgpt.com (for SSH/headless)'),
              value: 'device'
            }
          ]
        }
      ]);

      try {
        const { loginChatGPTBrowser, loginChatGPTDeviceCode } = await import('@meer-ai/core/auth/chatgpt/oauth.js');
        const readline = await import('readline');

        let creds;
        if (loginMethod === 'device') {
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
              console.log(chalk.dim(`\n  If it didn't open, visit:\n  ${chalk.blue.underline(url)}\n`));
            },
            onManualPrompt: () => new Promise((resolve) => {
              const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
              rl.question(chalk.dim('\nBrowser timed out. Paste the redirect URL or code: '), (ans) => {
                rl.close();
                resolve(ans);
              });
            }),
          });
        }

        authStorage.saveChatGPTCredentials(creds);
        console.log(chalk.green('\n✅ Logged in to ChatGPT successfully!'));
        console.log(chalk.dim(`   Account ID: ${creds.accountId}\n`));
      } catch (err) {
        console.log(chalk.red(`\n❌ Login failed: ${err instanceof Error ? err.message : String(err)}`));
        console.log(chalk.yellow('\nYou can retry anytime with: ') + chalk.cyan('meer login chatgpt\n'));
      }
    }

    const modelChoices = [
      { name: 'gpt-5.3-codex-spark (recommended — ChatGPT Plus+)', value: 'gpt-5.3-codex-spark' },
      { name: 'gpt-5.4-mini (faster, lighter)', value: 'gpt-5.4-mini' },
      { name: 'gpt-5.4', value: 'gpt-5.4' },
      { name: 'gpt-5.5 (flagship — ChatGPT Pro)', value: 'gpt-5.5' },
      { name: 'Custom model...', value: 'custom' },
    ];

    const { model } = await inquirer.prompt([
      {
        type: 'list',
        name: 'model',
        message: 'Choose a model:',
        choices: modelChoices,
      }
    ]);

    if (model === 'custom') {
      const { customModel } = await inquirer.prompt([
        { type: 'input', name: 'customModel', message: 'Enter model name (e.g., gpt-4o):' }
      ]);
      config.model = customModel || 'gpt-4o';
    } else {
      config.model = model;
    }

    console.log(chalk.green('\n✅ ChatGPT configured!'));
    console.log(chalk.gray(`   Model: ${config.model}`));
    console.log(chalk.blue('\n💬 Your ChatGPT Plus/Pro account will be used — no API costs.\n'));
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
