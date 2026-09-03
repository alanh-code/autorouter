import test from "node:test";
import assert from "node:assert/strict";
import {createOpenRouterAdapter, UpstreamGatewayError} from "../src/gateway/index.js";

test("discovers and normalizes the authenticated OpenRouter catalog", async () => {
  const requests: Array<{url: string; init: RequestInit}> = [];
  const adapter = createOpenRouterAdapter({
    fetchImpl: async (url, init) => {
      requests.push({url: String(url), init: init ?? {}});
      return Response.json({data: [{
        id: "vendor/model-a",
        name: "Model A",
        architecture: {input_modalities: ["text"], output_modalities: ["text"]},
        context_length: 128_000,
        pricing: {prompt: "0.000001", completion: "0.000002"},
        supported_parameters: ["temperature", "tools"],
        top_provider: {max_completion_tokens: 8_000}
      }]});
    }
  });

  const models = await adapter.listModels({apiKey: "test-key"});

  assert.equal(requests[0].url, "https://openrouter.ai/api/v1/models");
  assert.equal((requests[0].init.headers as Record<string, string>).Authorization, "Bearer test-key");
  assert.deepEqual(models, [{
    id: "vendor/model-a",
    name: "Model A",
    provider: "vendor",
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportedParameters: ["temperature", "tools"],
    contextTokens: 128_000,
    maxOutputTokens: 8_000,
    promptPricePerToken: 0.000001,
    completionPricePerToken: 0.000002
  }]);
});

test("sends one exact model through the buffered Responses API", async () => {
  let receivedUrl = "";
  let receivedMethod = "";
  let receivedBody: Record<string, unknown> | null = null;
  let receivedHeaders: HeadersInit | undefined;
  const adapter = createOpenRouterAdapter({
    fetchImpl: async (url, init) => {
      receivedUrl = String(url);
      receivedMethod = init?.method ?? "";
      receivedBody = JSON.parse(String(init?.body));
      receivedHeaders = init?.headers;
      return Response.json({
        id: "resp_test",
        model: "vendor/model-a",
        output_text: "done",
        usage: {input_tokens: 4, output_tokens: 2, total_tokens: 6, cost: 0.001},
        openrouter_metadata: {
          requested: "vendor/model-a",
          endpoints: {available: [{provider: "Provider A", selected: true}]}
        }
      });
    }
  });
  const request = adapter.translateRequest({
    request: {model: "autorouter", models: ["other/model"], input: "hello"},
    modelId: "vendor/model-a"
  });

  const response = await adapter.createResponse({
    headers: adapter.createAuthHeaders({apiKey: "test-key"}),
    request
  });

  assert.equal(receivedUrl, "https://openrouter.ai/api/v1/responses");
  assert.equal(receivedMethod, "POST");
  assert.deepEqual(receivedBody, {model: "vendor/model-a", input: "hello", stream: false});
  assert.equal((receivedHeaders as Record<string, string>)["X-OpenRouter-Metadata"], "enabled");
  assert.equal(response.output_text, "done");
  assert.deepEqual(adapter.normalizeUsage(response.usage), {
    inputTokens: 4,
    outputTokens: 2,
    totalTokens: 6,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    cost: 0.001
  });
  assert.deepEqual(adapter.extractExecutionMetadata({response, requestId: "upstream-request"}), {
    requestedModel: "vendor/model-a",
    actualModel: "vendor/model-a",
    actualProvider: "Provider A",
    requestId: "upstream-request"
  });
});

test("classifies OpenRouter HTTP failures without exposing credentials", async () => {
  const adapter = createOpenRouterAdapter({
    fetchImpl: async () => Response.json(
      {error: {code: 429, message: "Rate limit exceeded"}},
      {status: 429, headers: {"x-request-id": "request-test"}}
    )
  });

  await assert.rejects(
    adapter.listModels({apiKey: "private-test-value"}),
    (error: unknown) => {
      assert.ok(error instanceof UpstreamGatewayError);
      assert.equal(error.kind, "rate_limit");
      assert.equal(error.statusCode, 429);
      assert.equal(error.requestId, "request-test");
      assert.equal(error.retryable, true);
      assert.doesNotMatch(error.message, /private-test-value/);
      return true;
    }
  );
});

test("rejects malformed OpenRouter catalogs and buffered responses", async () => {
  const invalidCatalogAdapter = createOpenRouterAdapter({
    fetchImpl: async () => Response.json({data: [{name: "Missing ID"}]})
  });
  await assert.rejects(
    invalidCatalogAdapter.listModels({apiKey: "test-key"}),
    /OpenRouter model id is required/
  );

  const invalidResponseAdapter = createOpenRouterAdapter({
    fetchImpl: async () => Response.json({id: "resp_test"})
  });
  await assert.rejects(
    invalidResponseAdapter.createResponse({
      headers: invalidResponseAdapter.createAuthHeaders({apiKey: "test-key"}),
      request: {model: "vendor/model-a", input: "hello", stream: false}
    }),
    /OpenRouter response model is required/
  );
});
