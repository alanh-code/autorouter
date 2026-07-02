import {DEEPSEEK_DEFAULT_BASE_URL, OPENAI_COMPATIBLE_PROVIDERS} from "../constants.js";

export async function callChatCompletion({providerName, provider, modelName, messages, json = false, maxTokens = 700, thinking = "disabled", signal}) {
  if (OPENAI_COMPATIBLE_PROVIDERS.has(providerName)) {
    return callOpenAICompatibleChatCompletion({providerName, provider, modelName, messages, json, maxTokens, thinking, signal});
  }

  if (providerName === "anthropic") {
    return callAnthropicMessages({provider, modelName, messages, maxTokens, signal});
  }

  throw new Error(`API provider is not implemented yet: ${providerName}`);
}

async function callOpenAICompatibleChatCompletion({providerName, provider, modelName, messages, json = false, maxTokens = 700, thinking = "disabled", signal}) {
  const apiKey = process.env[provider.apiKeyEnv];

  if (!apiKey) {
    throw new Error(`Missing ${provider.apiKeyEnv}`);
  }

  const body = {
    model: modelName,
    messages,
    stream: false,
    max_tokens: maxTokens
  };

  if (providerName === "deepseek") {
    body.thinking = {type: thinking};
  }

  if (json) {
    body.response_format = {type: "json_object"};
  }

  const response = await fetch(`${provider.apiBaseUrl ?? DEEPSEEK_DEFAULT_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body),
    signal
  });

  if (!response.ok) {
    throw new Error(`${providerName} API returned ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;

  if (typeof content !== "string" || content.length === 0) {
    throw new Error(`${providerName} API returned empty content`);
  }

  return {
    content,
    usage: data.usage ?? null
  };
}

async function callAnthropicMessages({provider, modelName, messages, maxTokens = 700, signal}) {
  const apiKey = process.env[provider.apiKeyEnv];

  if (!apiKey) {
    throw new Error(`Missing ${provider.apiKeyEnv}`);
  }

  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const anthropicMessages = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: String(message.content ?? "")
    }));

  const response = await fetch(`${provider.apiBaseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": provider.apiVersion ?? "2023-06-01"
    },
    body: JSON.stringify({
      model: modelName,
      max_tokens: maxTokens,
      system,
      messages: anthropicMessages
    }),
    signal
  });

  if (!response.ok) {
    throw new Error(`anthropic API returned ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  const content = (data.content ?? [])
    .map((part) => part?.text ?? "")
    .join("")
    .trim();

  if (!content) {
    throw new Error("anthropic API returned empty content");
  }

  return {
    content,
    usage: data.usage ?? null
  };
}
