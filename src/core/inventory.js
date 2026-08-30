import {parseModelId} from "./model-id.js";

export function buildModelInventory(providers, includeProvider = () => true) {
  return Object.entries(providers ?? {}).flatMap(([providerName, provider]) => {
    if (!includeProvider(providerName, provider)) {
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

export function findModelById(models, modelId) {
  return models.find((model) => model.id === modelId) ?? null;
}

export function toRoutingInventory(models) {
  return models.map((model) => {
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
