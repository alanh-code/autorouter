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
    supported_parameters: []
  }))};
}

function mockAdapter(options: {failure?: boolean; incomplete?: boolean; invalidClassifier?: boolean} = {}) {
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
    adapter: mock.adapter, cachePath
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
  assert.equal(body.output[0].content[0].text, "Generated function");
  assert.deepEqual(body.usage, {input_tokens: 12, output_tokens: 8, total_tokens: 20});
  assert.deepEqual(mock.requests.map(request => request.model), [REQUEST_CLASSIFIER_MODEL, "vendor/b"]);
  assert.equal(mock.requests[1].max_output_tokens, 512);
  assert.equal(mock.catalogCalls, 1);
  assert.ok(fs.existsSync(cachePath));
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
    {stream: true}, {tools: [{type: "function"}]}, {previous_response_id: "resp_old"},
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
  assert.equal(result.usage.totalTokens, 20);
  controller.abort();
  assert.equal(mock.signals.length, 2);
  assert.ok(mock.signals.every(signal => signal.aborted));
});
