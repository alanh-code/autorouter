import test from "node:test";
import type {TestContext} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createRoutedGateway} from "../src/gateway/request-execution.ts";
import {createOpenRouterAdapter} from "../src/gateway/openrouter-adapter.ts";
import {REQUEST_CLASSIFIER_MODEL} from "../src/core/request-classifier.ts";

const encoder = new TextEncoder();
const first = ': keepalive\r\n\r\nevent: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"Hi"}\r\n\r\n';

async function fixture(context: TestContext, options: {status?: number; contentType?: string; tools?: unknown[]} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "router-stream-"));
  const calls: Record<string, unknown>[] = [];
  const signals: AbortSignal[] = [];
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancel!: () => void;
  const cancelled = new Promise<void>(resolve => {cancel = resolve;});
  const body = new ReadableStream<Uint8Array>({
    start(value) {controller = value; controller.enqueue(encoder.encode(first));},
    cancel() {cancel();}
  });
  const adapter = createOpenRouterAdapter({fetchImpl: async (url, init) => {
    if (String(url).endsWith("/models")) return Response.json({data: [{
      id: "vendor/model-a", name: "Model A", context_length: 128_000,
      top_provider: {max_completion_tokens: 4096},
      architecture: {input_modalities: ["text"], output_modalities: ["text"]},
      pricing: {prompt: "0.000001", completion: "0.000002"}, supported_parameters: ["tools"]
    }]});
    const request = JSON.parse(String(init?.body));
    calls.push(request);
    if (request.model === REQUEST_CLASSIFIER_MODEL) return Response.json({
      id: "resp_classify", model: REQUEST_CLASSIFIER_MODEL,
      output_text: JSON.stringify({taskCategory: "coding", confidence: 0.9, reason: "Text code generation",
        requiredCapabilities: {inputModalities: ["text"], outputModalities: ["text"], toolCalls: false}})
    });
    if (init?.signal) signals.push(init.signal);
    if (options.status) return Response.json({error: {message: "private credential detail"}}, {status: options.status});
    return new Response(body, {headers: {"Content-Type": options.contentType ?? "text/event-stream"}});
  }});
  const server = await createRoutedGateway({localApiKey: "local-key", credential: {gateway: "openrouter", apiKey: "test-key"},
    adapter, cachePath: path.join(directory, "cache", "benchmarks.json"), tracePath: path.join(directory, "traces.jsonl")});
  await new Promise<void>((resolve, reject) => {server.once("error", reject); server.listen(0, "127.0.0.1", resolve);});
  context.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, {recursive: true, force: true});
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
    method: "POST", headers: {Authorization: "Bearer local-key", "Content-Type": "application/json"},
    body: JSON.stringify({model: "autorouter", input: "Write a function", stream: true, tools: options.tools})
  });
  return {response, controller, calls, signals, cancelled};
}

test("forwards SSE incrementally with exact bytes, event order and final usage", {timeout: 5000}, async context => {
  const {response, controller, calls} = await fixture(context);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = response.body!.getReader();
  const initial = await reader.read();
  assert.equal(new TextDecoder().decode(initial.value), first);
  // The upstream has not ended yet: the first delta must already be available.
  const remaining = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"你好"}\n\n'
    + 'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"total_tokens":20}}}\n\n'
    + 'data: [DONE]\n\n';
  const bytes = encoder.encode(remaining);
  for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7));
  controller.close();
  const chunks: Uint8Array[] = [];
  while (true) {const chunk = await reader.read(); if (chunk.done) break; chunks.push(chunk.value);}
  assert.equal(Buffer.concat(chunks).toString("utf8"), remaining);
  assert.deepEqual(calls.map(call => [call.model, call.stream]), [[REQUEST_CLASSIFIER_MODEL, false], ["vendor/model-a", true]]);
});

test("preserves streamed function call IDs and argument deltas", {timeout: 5000}, async context => {
  const tools = [{type: "function", name: "read_file", parameters: {type: "object", properties: {}}}];
  const {response, controller, calls} = await fixture(context, {tools});
  const events = [
    {type: "response.output_item.added", output_index: 0, item: {type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: ""}},
    {type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: "{}"},
    {type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 0, arguments: "{}"},
    {type: "response.completed", response: {status: "completed", usage: {total_tokens: 12}}}
  ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  controller.enqueue(encoder.encode(events));
  controller.close();
  assert.equal(await response.text(), first + events);
  assert.deepEqual(calls[1].tools, tools);
});

test("forwards upstream failure events without adding completion", {timeout: 5000}, async context => {
  const {response, controller} = await fixture(context);
  const failure = 'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed"}}\n\n';
  controller.enqueue(encoder.encode(failure));
  controller.close();
  assert.equal(await response.text(), first + failure);
});

test("client cancellation aborts upstream and releases its stream reader", {timeout: 5000}, async context => {
  const {response, cancelled, signals} = await fixture(context);
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  await cancelled;
  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, true);
});

test("transport failure terminates the connection instead of fabricating success", {timeout: 5000}, async context => {
  const {response, controller} = await fixture(context);
  const reader = response.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), first);
  controller.error(new Error("private transport detail"));
  await assert.rejects(reader.read());
});

test("stream handshake errors remain sanitized HTTP errors", {timeout: 5000}, async context => {
  const {response} = await fixture(context, {status: 429});
  assert.equal(response.status, 429);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  assert.doesNotMatch(await response.text(), /private|credential/);
});

test("rejects a non-SSE upstream response before sending stream headers", {timeout: 5000}, async context => {
  const {response, cancelled} = await fixture(context, {contentType: "application/json"});
  assert.equal(response.status, 502);
  await cancelled;
});
