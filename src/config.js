import fs from "node:fs";
import path from "node:path";
import {
  CONFIG_FILE,
  DEEPSEEK_DEFAULT_BASE_URL,
  EXA_DEFAULT_BASE_URL,
  KIMI_K25_PRICING,
  KIMI_K26_PRICING,
  KIMI_K27_CODE_HIGHSPEED_PRICING,
  KIMI_K27_CODE_PRICING,
  LOCAL_ENV_FILE,
  MOONSHOT_V1_128K_PRICING,
  MOONSHOT_V1_32K_PRICING,
  MOONSHOT_V1_8K_PRICING
} from "./constants.js";

export const defaultConfig = {
  baseModels: [
    {
      id: "deepseek:deepseek-v4-pro",
      label: "DeepSeek V4 Pro",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      pricing: {inputCacheHitPerMillion: 0.003625, inputCacheMissPerMillion: 0.435, outputPerMillion: 0.87},
      maxTokens: 200
    },
    {
      id: "openai:gpt-5.5",
      label: "GPT 5.5",
      provider: "openai",
      model: "gpt-5.5",
      pricing: null,
      maxTokens: 200
    },
    {
      id: "anthropic:claude-4.7",
      label: "Claude 4.7",
      provider: "anthropic",
      model: "claude-4.7",
      pricing: null,
      maxTokens: 200
    },
    {
      id: "kimi:kimi-k2.7-code",
      label: "Kimi K2.7 Code",
      provider: "kimi",
      model: "kimi-k2.7-code",
      pricing: KIMI_K27_CODE_PRICING,
      maxTokens: 900
    }
  ],
  tools: {
    webSearch: {
      enabled: true,
      provider: "exa",
      providers: {
        exa: {
          apiKeyEnv: "EXA_API_KEY",
          apiBaseUrl: EXA_DEFAULT_BASE_URL,
          searchType: "auto",
          numResults: 5,
          contents: {highlights: true}
        }
      }
    }
  },
  providers: {
    openai: {
      enabled: true,
      apiKeyEnv: "OPENAI_API_KEY",
      apiBaseUrl: "https://api.openai.com/v1",
      models: [
        {
          id: "openai:gpt-5.5",
          label: "GPT 5.5",
          model: "gpt-5.5",
          pricing: null,
          maxTokens: 150
        },
        {
          id: "openai:gpt-5.4",
          label: "GPT 5.4",
          model: "gpt-5.4",
          pricing: null,
          maxTokens: 150
        }
      ]
    },
    anthropic: {
      enabled: true,
      apiKeyEnv: "ANTHROPIC_API_KEY",
      apiBaseUrl: "https://api.anthropic.com",
      models: [
        {
          id: "anthropic:claude-4.7",
          label: "Claude 4.7",
          model: "claude-4.7",
          pricing: null,
          maxTokens: 150
        }
      ]
    },
    kimi: {
      enabled: true,
      apiKeyEnv: "KIMI_API_KEY",
      apiBaseUrl: "https://api.moonshot.ai/v1",
      models: [
        {
          id: "kimi:kimi-k2.7-code",
          label: "Kimi K2.7 Code",
          model: "kimi-k2.7-code",
          pricing: KIMI_K27_CODE_PRICING,
          maxTokens: 900
        },
        {
          id: "kimi:kimi-k2.7-code-highspeed",
          label: "Kimi K2.7 Code Highspeed",
          model: "kimi-k2.7-code-highspeed",
          pricing: KIMI_K27_CODE_HIGHSPEED_PRICING,
          maxTokens: 900
        },
        {
          id: "kimi:kimi-k2.6",
          label: "Kimi K2.6",
          model: "kimi-k2.6",
          pricing: KIMI_K26_PRICING,
          maxTokens: 900
        },
        {
          id: "kimi:kimi-k2.5",
          label: "Kimi K2.5",
          model: "kimi-k2.5",
          pricing: KIMI_K25_PRICING,
          maxTokens: 900
        },
        {
          id: "kimi:moonshot-v1-128k",
          label: "Moonshot v1 128K",
          model: "moonshot-v1-128k",
          pricing: MOONSHOT_V1_128K_PRICING,
          maxTokens: 900
        },
        {
          id: "kimi:moonshot-v1-32k",
          label: "Moonshot v1 32K",
          model: "moonshot-v1-32k",
          pricing: MOONSHOT_V1_32K_PRICING,
          maxTokens: 900
        },
        {
          id: "kimi:moonshot-v1-8k",
          label: "Moonshot v1 8K",
          model: "moonshot-v1-8k",
          pricing: MOONSHOT_V1_8K_PRICING,
          maxTokens: 900
        },
        {
          id: "kimi:moonshot-v1-128k-vision-preview",
          label: "Moonshot v1 128K Vision Preview",
          model: "moonshot-v1-128k-vision-preview",
          pricing: MOONSHOT_V1_128K_PRICING,
          maxTokens: 900
        },
        {
          id: "kimi:moonshot-v1-32k-vision-preview",
          label: "Moonshot v1 32K Vision Preview",
          model: "moonshot-v1-32k-vision-preview",
          pricing: MOONSHOT_V1_32K_PRICING,
          maxTokens: 900
        },
        {
          id: "kimi:moonshot-v1-8k-vision-preview",
          label: "Moonshot v1 8K Vision Preview",
          model: "moonshot-v1-8k-vision-preview",
          pricing: MOONSHOT_V1_8K_PRICING,
          maxTokens: 900
        }
      ]
    },
    deepseek: {
      enabled: true,
      apiKeyEnv: "DEEPSEEK_API_KEY",
      apiBaseUrl: DEEPSEEK_DEFAULT_BASE_URL,
      models: [
        {
          id: "deepseek:deepseek-v4-pro",
          label: "DeepSeek V4 Pro",
          model: "deepseek-v4-pro",
          pricing: {inputCacheHitPerMillion: 0.003625, inputCacheMissPerMillion: 0.435, outputPerMillion: 0.87},
          maxTokens: 150
        },
        {
          id: "deepseek:deepseek-v4-flash",
          label: "DeepSeek V4 Flash",
          model: "deepseek-v4-flash",
          pricing: {inputCacheHitPerMillion: 0.0028, inputCacheMissPerMillion: 0.14, outputPerMillion: 0.28},
          maxTokens: 150
        }
      ]
    }
  }
};

export function initConfig() {
  const configPath = getConfigPath();

  if (fs.existsSync(configPath)) {
    console.log(`${CONFIG_FILE} already exists`);
    return;
  }

  fs.writeFileSync(configPath, `${JSON.stringify(defaultConfig, null, 2)}\n`);
  console.log(`Created ${CONFIG_FILE}`);
}

export function loadConfig() {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    return defaultConfig;
  }

  const raw = fs.readFileSync(configPath, "utf8");
  return JSON.parse(raw);
}

export function loadLocalEnv() {
  const envPath = path.join(process.cwd(), LOCAL_ENV_FILE);

  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value = unwrapEnvValue(rawValue);

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function getConfigPath() {
  return path.join(process.cwd(), CONFIG_FILE);
}

function unwrapEnvValue(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}
