import test from "node:test";
import type {TestContext} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createRoutedGateway, createRoutedResponseHandler} from "../src/gateway/request-execution.ts";
import {createOpenRouterAdapter} from "../src/gateway/openrouter-adapter.ts";
import {createBenchmarkSnapshot} from "../src/core/benchmark-data.ts";
import {REQUEST_CLASSIFIER_MODEL} from "../src/core/request-classifier.ts";

const classification = {
  taskCategory: "coding",
  requiredCapabilities: {inputModalities: ["text"], outputModalities: ["text"], toolCalls: false},
  confidence: 0.9, reason: "Generate a pure function."
};

function catalog() {
  return {data: ["a", "b"].map((id, index) => ({
    id: `vendor/${id}`, name: id,
    architecture: {input_modalities: ["text"], output_modalities: ["text"]},
    context_length: 128_000, top_provider: {max_completion_tokens: 4096},
    pricing: {prompt: "0.000001", completion: "0.000002"},
    benchmarks: {artificial_analysis: {coding_index: 60 + index}},
    supported_parameters: id === "a" ? ["tools"] : []
  }))};
}

function mockAdapter(options: {failure?: boolean; incomplete?: boolean; invalidClassifier?: boolean;
  targetStatus?: number; targetResponse?: Record<string, unknown>} = {}) {
  const requests: Record<string, unknown>[] = [];
  const signals: AbortSignal[] = [];
  let catalogCalls = 0;
  const adapter = createOpenRouterAdapter({fetchImpl: async (url, init) => {
    if (String(url).endsWith("/models")) {
      catalogCalls++;
      return Response.json(catalog());
    }
    const body = JSON.parse(String(init?.body));
    if (init?.signal) signals.push(init.signal);
    requests.push(body);
    if (options.failure) return Response.json({error: {message: "private upstream-key"}}, {status: 429});
    if (body.model === REQUEST_CLASSIFIER_MODEL) return Response.json({
      id: "resp_classify", model: REQUEST_CLASSIFIER_MODEL,
      output_text: options.invalidClassifier ? "invalid" : JSON.stringify(classification)
    });
    if (options.targetStatus) return Response.json({error: {message: "private upstream-key", code: "private-code"}}, {status: options.targetStatus});
    if (options.targetResponse) return Response.json(options.targetResponse);
    return Response.json({
      id: "resp_execute", object: "response", model: body.model,
      status: options.incomplete ? "incomplete" : "completed",
      output: [{type: "message", role: "assistant", content: [{type: "output_text", text: "Generated function"}]}],
      usage: {input_tokens: 12, output_tokens: 8, total_tokens: 20},
      incomplete_details: options.incomplete ? {reason: "max_output_tokens"} : null
    });
  }});
  return {adapter, requests, signals, get catalogCalls() {return catalogCalls;}};
}

async function fixture(context: TestContext, options: Parameters<typeof mockAdapter>[0] = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "router-execution-"));
  const cachePath = path.join(directory, "cache", "benchmarks.json");
  const mock = mockAdapter(options);
  const server = await createRoutedGateway({
    localApiKey: "local-key", credential: {gateway: "openrouter", apiKey: "upstream-key"},
    adapter: mock.adapter, cachePath, tracePath: path.join(directory, "traces.jsonl")
  });
  await new Promise<void>((resolve, reject) => {server.once("error", reject); server.listen(0, "127.0.0.1", resolve);});
  context.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    fs.rmSync(directory, {recursive: true, force: true});
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const send = (body: Record<string, unknown>) => fetch(`${baseUrl}/v1/responses`, {
    method: "POST", headers: {Authorization: "Bearer local-key", "Content-Type": "application/json"},
    body: JSON.stringify({model: "autorouter", input: "Write a pure sorting function", ...body})
  });
  return {mock, cachePath, baseUrl, send};
}

test("runs local HTTP requests through classification, selection and exact execution", async context => {
  const {send, mock, cachePath, baseUrl} = await fixture(context);
  const modelsResponse = await fetch(`${baseUrl}/v1/models`, {headers: {Authorization: "Bearer local-key"}});
  assert.deepEqual((await modelsResponse.json()).data.map((model: {id: string}) => model.id), ["autorouter"]);
  const response = await send({max_output_tokens: 512});
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.id, "resp_execute");
  assert.equal(body.model, "vendor/b");
  assert.deepEqual(mock.requests[0].reasoning, {enabled: false});
  assert.deepEqual(mock.requests[0].provider, {require_parameters: true, sort: "price"});
  assert.equal(mock.requests[0].temperature, 0);
  assert.equal(mock.requests[1].reasoning, undefined);
  assert.equal(mock.requests[1].provider, undefined);
  assert.equal(mock.requests[1].temperature, undefined);
  assert.equal(body.output[0].content[0].text, "Generated function");
  assert.deepEqual(body.usage, {input_tokens: 12, output_tokens: 8, total_tokens: 20});
  assert.deepEqual(mock.requests.map(request => request.model), [REQUEST_CLASSIFIER_MODEL, "vendor/b"]);
  assert.equal(mock.requests[1].max_output_tokens, 512);
  assert.equal(mock.catalogCalls, 1);
  assert.ok(fs.existsSync(cachePath));
  const trace = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(cachePath)), "traces.jsonl"), "utf8"));
  assert.equal(trace.decision.upstreamModelId, "vendor/b");
  assert.equal(trace.actualModel, "vendor/b");
  assert.equal(trace.usage.totalTokens, 20);
  assert.equal(trace.usage.cost, null);
  assert.equal(trace.classifier.classification.taskCategory, "coding");
  assert.equal(trace.classifier.classification.reason, undefined);
});

const functionTool = {type: "function", name: "read_file", description: "Read a project file",
  parameters: {type: "object", properties: {path: {type: "string"}}, required: ["path"], additionalProperties: false}, strict: true};
const functionCall = {type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: '{"path":"index.ts"}', status: "completed"};

test("preserves function definitions, call output and usage while selecting a tool-capable model", async context => {
  const targetResponse = {id: "resp_tools", object: "response", model: "vendor/a", status: "completed",
    output: [functionCall], usage: {input_tokens: 30, output_tokens: 10, total_tokens: 40, output_tokens_details: {reasoning_tokens: 2}}};
  const {send, mock} = await fixture(context, {targetResponse});
  const response = await send({tools: [functionTool], tool_choice: {type: "function", name: "read_file"}, parallel_tool_calls: false});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), targetResponse);
  const request = mock.requests[1];
  assert.equal(request.model, "vendor/a");
  assert.deepEqual(request.tools, [functionTool]);
  assert.deepEqual(request.tool_choice, {type: "function", name: "read_file"});
  assert.equal(request.parallel_tool_calls, false);
});

test("accepts a tool result follow-up with complete history and preserves call IDs", async context => {
  const {send, mock} = await fixture(context);
  const input = [{role: "user", content: "Read the file"}, functionCall,
    {type: "function_call_output", call_id: "call_1", output: "export const answer = 42;"}];
  const response = await send({input, tools: [functionTool]});
  assert.equal(response.status, 200);
  assert.deepEqual(mock.requests[1].input, input);
  assert.equal(mock.requests[1].model, "vendor/a");
});

test("includes tool schemas in the input budget", async () => {
  const mock = mockAdapter();
  const models = await mock.adapter.listModels({apiKey: "upstream-key"});
  const handler = createRoutedResponseHandler({catalog: models, benchmarks: createBenchmarkSnapshot(models), adapter: mock.adapter, apiKey: "upstream-key"});
  const request = {model: "autorouter", input: "Read a file", tools: [functionTool]};
  const result = await handler(request);
  assert.equal(result.tokenEstimate.input, Buffer.byteLength(JSON.stringify({input: request.input, tools: request.tools}), "utf8"));
});

test("rejects invalid tools and function history before inference", async context => {
  const {send, mock} = await fixture(context);
  for (const body of [{tools: [{}]}, {tools: [{type: "web_search"}]},
    {input: [{type: "function_call", name: "read_file", arguments: "{}"}]},
    {input: [{type: "function_call_output", call_id: "call_1", output: {text: "invalid"}}]}]) {
    assert.equal((await send(body)).status, 400);
  }
  assert.equal(mock.requests.length, 0);
});

test("preserves a failed response envelope without fabricating completion", async context => {
  const targetResponse = {id: "resp_failed", object: "response", model: "vendor/b", status: "failed", output: [],
    error: {code: "server_error", message: "Generation failed"}, usage: {input_tokens: 5, output_tokens: 0, total_tokens: 5}};
  const {send} = await fixture(context, {targetResponse});
  assert.deepEqual(await (await send({})).json(), targetResponse);
});

test("preserves upstream HTTP status and compatible error types without raw error details", async context => {
  for (const [status, type] of [[400, "invalid_request_error"], [401, "authentication_error"],
    [429, "rate_limit_error"], [503, "server_error"]] as const) {
    const {send} = await fixture(context, {targetStatus: status});
    const response = await send({});
    assert.equal(response.status, status);
    const body = await response.json();
    assert.equal(body.error.type, type);
    assert.equal(body.error.code, "upstream_error");
    assert.doesNotMatch(JSON.stringify(body), /private|upstream-key/);
  }
});

test("preserves incomplete upstream responses instead of reporting success", async context => {
  const {send} = await fixture(context, {incomplete: true});
  const body = await (await send({})).json();
  assert.equal(body.status, "incomplete");
  assert.deepEqual(body.incomplete_details, {reason: "max_output_tokens"});
});

test("rejects unsupported request features before upstream inference", async context => {
  const {send, mock} = await fixture(context);
  for (const body of [
    {stream: "true"}, {tools: [{type: "function"}]}, {previous_response_id: "resp_old"},
    {input: [{role: "user", content: [{type: "input_image", image_url: "image"}]}]},
    {max_output_tokens: -1}, {model: "other"}
  ]) assert.equal((await send(body)).status, 400);
  assert.equal(mock.requests.length, 0);
});

test("returns sanitized upstream errors and stops after classification failure", async context => {
  const {send, mock} = await fixture(context, {failure: true});
  const response = await send({});
  assert.equal(response.status, 429);
  assert.doesNotMatch(await response.text(), /private|upstream-key/);
  assert.equal(mock.requests.length, 1);
});

test("does not execute a target model when classifier output is invalid", async context => {
  const {send, mock} = await fixture(context, {invalidClassifier: true});
  assert.equal((await send({})).status, 500);
  assert.equal(mock.requests.length, 1);
});

test("loads an existing snapshot without replacing it at startup", async context => {
  const {mock, cachePath} = await fixture(context);
  const original = fs.readFileSync(cachePath, "utf8");
  await createRoutedGateway({localApiKey: "local-key", credential: {gateway: "openrouter", apiKey: "upstream-key"}, adapter: mock.adapter, cachePath});
  assert.equal(fs.readFileSync(cachePath, "utf8"), original);
});

test("returns routing evidence and forwards cancellation for text message history", async () => {
  const mock = mockAdapter();
  const models = await mock.adapter.listModels({apiKey: "upstream-key"});
  const handler = createRoutedResponseHandler({catalog: models, benchmarks: createBenchmarkSnapshot(models), adapter: mock.adapter, apiKey: "upstream-key"});
  const controller = new AbortController();
  const result = await handler({model: "autorouter", input: [{role: "user", content: "Write a function"}]}, {signal: controller.signal});
  assert.equal(result.decision.modelId, "vendor:b");
  assert.equal(result.classification.taskCategory, "coding");
  assert.equal(result.tokenEstimate.method, "utf8_bytes");
  assert.equal(result.tokenEstimate.outputBudget, 1024);
  assert.ok("usage" in result);
  assert.equal(result.usage.totalTokens, 20);
  controller.abort();
  assert.equal(mock.signals.length, 2);
  assert.ok(mock.signals.every(signal => signal.aborted));
});

for (const scenario of ["buffered", "streaming", "pricing only", "batch in model name"]) {
  test(`excludes batch variants from realtime routing: ${scenario}`, async () => {
    const mock = mockAdapter();
    const source = (await mock.adapter.listModels({apiKey: "test-key"}))[1];
    const normal = {...source, id: scenario === "batch in model name" ? "vendor/batch-helper:free" : source.id};
    const batch = {...source, id: `${source.id}:batch`, promptPricePerToken: 0, completionPricePerToken: 0,
      benchmarks: {...source.benchmarks, artificialAnalysis: {intelligenceIndex: 100, codingIndex: 100, agenticIndex: 100}}};
    const models = [normal, batch];
    const streamed: Record<string, unknown>[] = [];
    const adapter = {...mock.adapter, async streamResponse({request}: {request: unknown}) {
      streamed.push(request as Record<string, unknown>);
      return (async function* () {yield new TextEncoder().encode("data: [DONE]\n\n");})();
    }};
    const handler = createRoutedResponseHandler({catalog: models,
      benchmarks: createBenchmarkSnapshot(scenario === "pricing only" ? [] : models), adapter, apiKey: "test-key"});
    const result = await handler({model: "autorouter", input: "Write a sorting function", stream: scenario === "streaming"});
    assert.equal(result.decision.upstreamModelId, normal.id);
    assert.ok(result.decision.candidates.every(candidate => candidate.upstreamModelId !== batch.id));
    if ("stream" in result) {
      for await (const chunk of result.stream) assert.ok(chunk.byteLength > 0);
      assert.equal(streamed[0].model, normal.id);
      assert.equal(mock.requests.length, 1);
    } else {
      assert.equal(mock.requests[1].model, normal.id);
    }
  });
}

test("a batch-only catalog cannot trigger realtime target execution", async () => {
  const mock = mockAdapter();
  const source = (await mock.adapter.listModels({apiKey: "test-key"}))[1];
  const models = [{...source, id: `${source.id}:batch`}];
  let streamed = false;
  const adapter = {...mock.adapter, async streamResponse() {
    streamed = true;
    return (async function* () {})();
  }};
  const handler = createRoutedResponseHandler({catalog: models, benchmarks: createBenchmarkSnapshot(models), adapter, apiKey: "test-key"});
  for (const stream of [false, true]) {
    await assert.rejects(handler({model: "autorouter", input: "Write a sorting function", stream}), /No eligible model/);
  }
  assert.equal(streamed, false);
  assert.equal(mock.requests.length, 2);
  assert.ok(mock.requests.every(request => request.model === REQUEST_CLASSIFIER_MODEL));
});
