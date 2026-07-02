import test from "node:test";
import assert from "node:assert/strict";
import {buildRouterEntry, getRoutePreviewLines} from "../src/app.js";

test("router clarification path uses base model clarification", async () => {
  process.env.AUTOROUTER_TEST_KEY = "test-key";
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, options) => {
    calls.push({url, options});

    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  clarification: "Which target should I use?"
                })
              }
            }
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20
          }
        };
      }
    };
  };

  try {
    const config = {
      providers: {
        deepseek: {
          enabled: true,
          apiKeyEnv: "AUTOROUTER_TEST_KEY",
          apiBaseUrl: "https://example.invalid",
          models: [
            {
              id: "deepseek:test-model",
              label: "Test Model",
              model: "test-model",
              pricing: null,
              maxTokens: 100
            }
          ]
        }
      },
      tools: {}
    };
    const selectedBaseModel = {
      id: "deepseek:test-model",
      label: "Test Model",
      provider: "deepseek",
      model: "test-model",
      pricing: null,
      maxTokens: 100
    };

    const entry = await buildRouterEntry(
      "review this project",
      config,
      selectedBaseModel,
      true
    );

    assert.equal(entry.type, "clarification");
    assert.equal(entry.question, "Which target should I use?");
    assert.equal(calls.length, 1);
    assert.match(calls[0].options.body, /Do not guess or infer missing requirements/);
    assert.match(calls[0].options.body, /Clarification response shape/);
    assert.doesNotMatch(calls[0].options.body, /What gender or style/);
    assert.doesNotMatch(calls[0].options.body, /style preference for clothing/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("router analysis path builds runtime context and parses model stages", async () => {
  process.env.AUTOROUTER_TEST_KEY = "test-key";
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, options) => {
    calls.push({url, options});

    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  stages: [
                    {
                      label: "look up result",
                      kind: "search",
                      goal: "Find current answer",
                      modelId: "deepseek:test-model",
                      modelChoiceReason: "Chosen because web search provides freshness and this model is enough for short synthesis.",
                      tools: ["web_search"]
                    }
                  ]
                })
              }
            }
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20
          }
        };
      }
    };
  };

  try {
    const config = {
      providers: {
        deepseek: {
          enabled: true,
          apiKeyEnv: "AUTOROUTER_TEST_KEY",
          apiBaseUrl: "https://example.invalid",
          models: [
            {
              id: "deepseek:test-model",
              label: "Test Model",
              model: "test-model",
              pricing: {inputPerMillion: 1, outputPerMillion: 2},
              maxTokens: 100
            }
          ]
        }
      },
      tools: {}
    };
    const selectedBaseModel = {
      id: "deepseek:test-model",
      label: "Test Model",
      provider: "deepseek",
      model: "test-model",
      pricing: {inputPerMillion: 1, outputPerMillion: 2},
      maxTokens: 100
    };

    const entry = await buildRouterEntry(
      "who win FIFA 2025",
      config,
      selectedBaseModel,
      true
    );

    assert.equal(entry.type, "router");
    assert.equal(entry.routes.length, 1);
    assert.equal(entry.routes[0].stage, "look up result");
    assert.deepEqual(entry.routes[0].tools, ["web_search"]);
    assert.equal(
      entry.routes[0].modelChoiceReason,
      "Chosen because web search provides freshness and this model is enough for short synthesis."
    );
    assert.equal(calls.length, 1);
    assert.match(calls[0].options.body, /Current date:/);
    assert.match(calls[0].options.body, /Current working directory:/);
    assert.match(calls[0].options.body, /modelChoiceReason/);
    assert.match(calls[0].options.body, /explaining the model choice over alternatives/);
    assert.match(calls[0].options.body, /1 to 6 stages/);
    assert.match(calls[0].options.body, /Simple questions can be one stage/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("route preview lines avoid padded alignment", () => {
  assert.deepEqual(
    getRoutePreviewLines(
      {
        stage: "Research architecture docs",
        modelLabel: "Moonshot v1 8K",
        provider: "kimi",
        tools: ["web_search"],
        modelChoiceReason: "Cheap and sufficient for a factual web search with adequate token budget."
      },
      0
    ),
    [
      "1. Research architecture docs",
      "model: Moonshot v1 8K",
      "tool: web_search",
      "reason: Cheap and sufficient for a factual web search with adequate token budget."
    ]
  );

  assert.deepEqual(
    getRoutePreviewLines(
      {
        stage: "Summarize findings",
        modelLabel: "Moonshot v1 8K",
        provider: "kimi",
        tools: [],
        modelChoiceReason: "Low cost model is sufficient for concise synthesis."
      },
      1
    ),
    [
      "2. Summarize findings",
      "model: Moonshot v1 8K",
      "reason: Low cost model is sufficient for concise synthesis."
    ]
  );
});
