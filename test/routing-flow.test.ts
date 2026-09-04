import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createRoutedGateway} from "../src/gateway/request-execution.ts";
import {createOpenRouterAdapter} from "../src/gateway/openrouter-adapter.ts";
import {REQUEST_CLASSIFIER_MODEL} from "../src/core/request-classifier.ts";

test("routes an authenticated streaming tool round trip and persists matching traces", {timeout: 10_000}, async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "routing-flow-"));
  context.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const tracePath = path.join(directory, "traces.jsonl");
  const requests: Record<string, unknown>[] = [];
  const call = {type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: '{"path":"sample.ts"}', status: "completed"};
  const tools = [{type: "function", name: "read_file", parameters: {
    type: "object", properties: {path: {type: "string"}}, required: ["path"]
  }}];
  let release!: () => void;
  const released = new Promise<void>(resolve => {release = resolve;});
  const event = (type: string, fields: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({type, ...fields})}\n\n`;
  const first = event("response.output_item.added", {output_index: 0, item: {...call, arguments: ""}});
  const usage = {input_tokens: 30, output_tokens: 10, total_tokens: 40, cost: 0.0001};
  const terminal = {id: "resp_tool", object: "response", model: "vendor/tool-model", status: "completed", output: [call], usage};
  const rest = event("response.function_call_arguments.delta", {item_id: call.id, output_index: 0, delta: call.arguments})
    + event("response.output_item.done", {output_index: 0, item: call})
    + event("response.completed", {response: terminal}) + "data: [DONE]\n\n";
  const adapter = createOpenRouterAdapter({fetchImpl: async (url, init) => {
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer upstream-test-key");
    if (String(url).endsWith("/models")) return Response.json({data: [
      {id: "text-model", score: 99, tools: false},
      {id: "tool-model", score: 70, tools: true},
      {id: "other-tool-model", score: 50, tools: true}
    ].map(model => ({id: `vendor/${model.id}`, name: model.id, context_length: 128_000,
      top_provider: {max_completion_tokens: 4096}, architecture: {input_modalities: ["text"], output_modalities: ["text"]},
      pricing: {prompt: "0.000001", completion: "0.000002"}, supported_parameters: model.tools ? ["tools"] : [],
      benchmarks: {artificial_analysis: {coding_index: model.score}}
    }))});
    assert.equal(String(url), "https://openrouter.ai/api/v1/responses");
    const request = JSON.parse(String(init?.body));
    requests.push(request);
    if (request.model === REQUEST_CLASSIFIER_MODEL) return Response.json({id: "resp_classifier", model: request.model,
      output_text: JSON.stringify({taskCategory: "coding", confidence: 0.9, reason: "Code inspection",
        requiredCapabilities: {inputModalities: ["text"], outputModalities: ["text"], toolCalls: false}})});
    assert.equal(request.model, "vendor/tool-model");
    assert.deepEqual(request.tools, tools);
    assert.equal(request.models, undefined);
    assert.equal(request.route, undefined);
    if (request.stream) {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from(first));
          void released.then(() => {controller.enqueue(Buffer.from(rest)); controller.close();});
        }
      }), {headers: {"Content-Type": "text/event-stream"}});
    }
    return Response.json({id: "resp_final", object: "response", model: request.model, status: "completed",
      output: [{type: "message", role: "assistant", content: [{type: "output_text", text: "The value is 42."}]}], usage});
  }});
  const server = await createRoutedGateway({localApiKey: "local-test-key", credential: {gateway: "openrouter", apiKey: "upstream-test-key"},
    adapter, cachePath: path.join(directory, "benchmarks.json"), tracePath});
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));});
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const send = (body: Record<string, unknown>, key = "local-test-key") => fetch(`${base}/v1/responses`, {
    method: "POST", headers: {Authorization: `Bearer ${key}`, "Content-Type": "application/json"}, body: JSON.stringify(body)
  });
  const request = {model: "autorouter", input: [{role: "user", content: "Inspect sample.ts"}], tools};
  assert.equal((await send(request, "wrong-key")).status, 401);
  assert.equal(requests.length, 0);
  const models = await fetch(`${base}/v1/models`, {headers: {Authorization: "Bearer local-test-key"}});
  assert.deepEqual((await models.json()).data.map((item: {id: string}) => item.id), ["autorouter"]);
  const response = await send({...request, stream: true});
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const initial = await reader.read();
  assert.equal(Buffer.from(initial.value!).toString(), first);
  // The first event arrives before the mock upstream is allowed to finish.
  release();
  const chunks: Uint8Array[] = [];
  while (true) {const {done, value} = await reader.read(); if (done) break; chunks.push(value);}
  assert.equal(Buffer.concat(chunks).toString(), rest);
  const outputEvent = (first + rest).split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)))
    .find(item => item.type === "response.output_item.done");
  // A stand-in client returns tool output. No model output is executed by this test.
  const history = [...request.input, outputEvent.item, {type: "function_call_output", call_id: outputEvent.item.call_id, output: "export const value = 42;"}];
  const followup = await send({...request, input: history, stream: false});
  assert.equal(followup.status, 200);
  assert.equal((await followup.json()).output[0].content[0].text, "The value is 42.");
  assert.deepEqual(requests[3].input, history);
  assert.deepEqual(requests.map(item => item.model), [REQUEST_CLASSIFIER_MODEL, "vendor/tool-model", REQUEST_CLASSIFIER_MODEL, "vendor/tool-model"]);
  const rawTrace = fs.readFileSync(tracePath, "utf8");
  const rows = rawTrace.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].requestId, rows[1].requestId);
  for (const row of rows) {
    assert.equal(row.policyVersion, "benchmark-first-v1");
    assert.equal(row.decision.mode, "benchmark");
    assert.deepEqual(row.decision.candidates.map((item: {modelId: string}) => item.modelId), ["vendor:tool-model", "vendor:other-tool-model"]);
    assert.equal(row.decision.upstreamModelId, row.actualModel);
    assert.equal(row.actualModel, "vendor/tool-model");
    assert.equal(row.status, "completed");
    assert.equal(row.error, null);
    assert.equal(row.usage.totalTokens, usage.total_tokens);
    assert.equal(row.usage.cost, usage.cost);
    assert.ok(row.latencyMs >= 0);
  }
  assert.deepEqual(rows.map(row => row.upstreamRequestId), ["resp_tool", "resp_final"]);
  assert.doesNotMatch(rawTrace, /sample\.ts|export const|local-test-key|upstream-test-key|Code inspection/);
});
