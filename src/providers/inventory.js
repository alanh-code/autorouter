import {OPENAI_COMPATIBLE_PROVIDERS} from "../constants.js";
import {buildModelInventory, findModelById, toRoutingInventory} from "../core/inventory.js";
import {normalizeModel, parseModelId} from "../core/model-id.js";

export function getProviderConfig(config, providerName) {
  return config.providers?.[providerName] ?? null;
}

export function normalizeBaseModel(model) {
  return normalizeModel(model);
}

export {parseModelId};

export function getEnabledModels(config) {
  return buildModelInventory(
    config.providers,
    (providerName, provider) => isProviderAvailable(config, providerName, provider)
  );
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
  return findModelById(getEnabledModels(config), modelId);
}

export function getModelInventoryForPrompt(config) {
  return toRoutingInventory(getEnabledModels(config));
}
