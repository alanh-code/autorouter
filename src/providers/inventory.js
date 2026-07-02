import {OPENAI_COMPATIBLE_PROVIDERS} from "../constants.js";

export function getProviderConfig(config, providerName) {
  return config.providers?.[providerName] ?? null;
}

export function normalizeBaseModel(model) {
  const parsed = parseModelId(model?.id);
  return {
    ...model,
    provider: model?.provider ?? parsed.provider,
    model: model?.model ?? parsed.model
  };
}

export function parseModelId(id) {
  if (!id || !id.includes(":")) {
    return {provider: "", model: id ?? ""};
  }

  const [provider, ...modelParts] = id.split(":");
  return {provider, model: modelParts.join(":")};
}

export function getEnabledModels(config) {
  return Object.entries(config.providers ?? {}).flatMap(([providerName, provider]) => {
    if (!isProviderAvailable(config, providerName, provider)) {
      return [];
    }

    return (provider.models ?? []).map((model) => ({
      ...model,
      provider: providerName,
      apiKeyEnv: provider.apiKeyEnv,
      apiBaseUrl: provider.apiBaseUrl
    }));
  });
}

export function getAvailableModelChoices(config) {
  return getEnabledModels(config).map((model) => normalizeBaseModel(model));
}

export function isProviderAvailable(_config, providerName, provider) {
  return Boolean(
    provider &&
    provider.enabled !== false &&
    provider.apiKeyEnv &&
    process.env[provider.apiKeyEnv] &&
    isProviderAdapterAvailable(providerName, provider)
  );
}

export function isProviderAdapterAvailable(providerName, provider) {
  if (OPENAI_COMPATIBLE_PROVIDERS.has(providerName)) {
    return Boolean(provider.apiBaseUrl);
  }

  return providerName === "anthropic";
}

export function getEnabledModelById(config, modelId) {
  return getEnabledModels(config).find((model) => model.id === modelId) ?? null;
}

export function getModelInventoryForPrompt(config) {
  return getEnabledModels(config).map((model) => {
    const parsed = parseModelId(model.id);
    return {
      id: model.id,
      label: model.label ?? model.id,
      provider: model.provider ?? parsed.provider,
      model: model.model ?? parsed.model,
      pricing: model.pricing ?? null,
      maxTokens: model.maxTokens ?? null
    };
  });
}
