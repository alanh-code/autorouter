import test from "node:test";
import assert from "node:assert/strict";
import {
  buildModelInventory,
  findModelById,
  formatDollarCost,
  formatUsageCost,
  normalizeModel,
  parseDollarText,
  parseModelId,
  toRoutingInventory,
  validateStageModelIds
} from "../src/core/index.js";

test("parses and normalizes canonical model IDs", () => {
  assert.deepEqual(parseModelId("gateway:vendor:model"), {
    provider: "gateway",
    model: "vendor:model"
  });
  assert.deepEqual(normalizeModel({id: "gateway:model-a"}), {
    id: "gateway:model-a",
    provider: "gateway",
    model: "model-a"
  });
});

test("builds a model inventory from explicit provider inputs", () => {
  const providers = {
    first: {
      apiKeyEnv: "FIRST_KEY",
      apiBaseUrl: "https://first.example/v1",
      models: [{id: "first:model-a", label: "Model A"}]
    },
    second: {
      apiKeyEnv: "SECOND_KEY",
      apiBaseUrl: "https://second.example/v1",
      models: [{id: "second:model-b", label: "Model B"}]
    }
  };

  assert.deepEqual(
    buildModelInventory(providers, (providerName) => providerName === "first"),
    [
      {
        id: "first:model-a",
        label: "Model A",
        provider: "first",
        apiKeyEnv: "FIRST_KEY",
        apiBaseUrl: "https://first.example/v1"
      }
    ]
  );
});

test("finds models and produces routing policy input", () => {
  const models = [
    {
      id: "gateway:model-a",
      label: "Model A",
      pricing: {inputPerMillion: 1},
      maxTokens: 400,
      apiKeyEnv: "PRIVATE_KEY_NAME"
    }
  ];

  assert.equal(findModelById(models, "gateway:model-a"), models[0]);
  assert.equal(findModelById(models, "gateway:missing"), null);
  assert.deepEqual(toRoutingInventory(models), [
    {
      id: "gateway:model-a",
      label: "Model A",
      provider: "gateway",
      model: "model-a",
      pricing: {inputPerMillion: 1},
      maxTokens: 400
    }
  ]);
});

test("calculates and parses model usage costs", () => {
  assert.equal(
    formatUsageCost(
      {prompt_tokens: 1_000_000, completion_tokens: 500_000},
      {pricing: {inputPerMillion: 1, outputPerMillion: 2}}
    ),
    "$2.000000"
  );
  assert.equal(formatDollarCost(0), "$0.000000");
  assert.equal(parseDollarText("$2.000000"), 2);
});

test("validates selected models against the available inventory", () => {
  assert.equal(
    validateStageModelIds(
      [{label: "summarize", modelId: "missing:model"}],
      [{id: "gateway:model-a"}]
    ),
    "base model selected unavailable model IDs: summarize -> missing:model. Available models: gateway:model-a"
  );
});
