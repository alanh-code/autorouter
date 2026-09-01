import test from "node:test";
import assert from "node:assert/strict";
import {
  createCanonicalInventory,
  listAvailableCanonicalModels
} from "../src/core/index.js";

test("creates an immutable canonical model inventory", () => {
  const inventory = createCanonicalInventory([createModel()]);

  assert.deepEqual(inventory, [
    {
      id: "vendor:model-a",
      label: "Model A",
      provider: "vendor",
      model: "model-a",
      capabilities: {
        inputModalities: ["text", "image"],
        outputModalities: ["text"],
        toolCalls: true,
        streaming: true
      },
      pricing: {inputPerMillion: 1, outputPerMillion: 2},
      limits: {contextTokens: 128_000, maxOutputTokens: 8_000},
      upstreams: {
        first: {modelId: "vendor/model-a", available: true},
        second: {modelId: null, available: false}
      },
      supportedUpstreams: ["first", "second"],
      available: true
    }
  ]);
  assert.equal(Object.isFrozen(inventory), true);
  assert.equal(Object.isFrozen(inventory[0].capabilities), true);
});

test("filters canonical models by current upstream availability", () => {
  const inventory = createCanonicalInventory([
    createModel(),
    createModel({
      id: "vendor:model-b",
      label: "Model B",
      upstreams: {
        first: {modelId: null, available: false},
        second: {modelId: "provider:model-b", available: true}
      }
    })
  ]);

  assert.deepEqual(
    listAvailableCanonicalModels(inventory, "first").map((model) => model.id),
    ["vendor:model-a"]
  );
  assert.deepEqual(
    listAvailableCanonicalModels(inventory, "second").map((model) => model.id),
    ["vendor:model-b"]
  );
  assert.equal(listAvailableCanonicalModels(inventory).length, 2);
});

test("rejects inconsistent canonical inventory records", () => {
  assert.throws(
    () => createCanonicalInventory([createModel(), createModel()]),
    /Duplicate canonical model id/
  );
  assert.throws(
    () => createCanonicalInventory([createModel({provider: "other"})]),
    /provider does not match id/
  );
  assert.throws(
    () => createCanonicalInventory([createModel({
      upstreams: {first: {modelId: null, available: true}}
    })]),
    /missing a model id/
  );
  assert.throws(
    () => createCanonicalInventory([createModel({pricing: {inputPerMillion: -1}})]),
    /Invalid inputPerMillion pricing/
  );
  assert.throws(
    () => createCanonicalInventory([createModel({pricing: {inputPrice: 1}})]),
    /Unsupported pricing/
  );
});

function createModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "vendor:model-a",
    label: "Model A",
    capabilities: {
      inputModalities: ["text", "image", "text"],
      outputModalities: ["text"],
      toolCalls: true,
      streaming: true
    },
    pricing: {inputPerMillion: 1, outputPerMillion: 2},
    limits: {contextTokens: 128_000, maxOutputTokens: 8_000},
    upstreams: {
      first: {modelId: "vendor/model-a", available: true},
      second: {modelId: null, available: false}
    },
    ...overrides
  };
}
