import test from "node:test";
import type {TestContext} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {startRoutingTrace} from "../src/gateway/routing-trace.ts";

function fixture(context: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "routing-trace-"));
  context.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const file = path.join(directory, "nested", "traces.jsonl");
  return {file, read: () => fs.readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line))};
}

test("writes private append-only records with unique IDs and allowlisted response metadata", context => {
  const {file, read} = fixture(context);
  for (let i = 0; i < 2; i++) {
    const trace = startRoutingTrace(file);
    trace.observe({id: "resp_1", model: "vendor/model", status: "completed", output: "secret prompt",
      usage: {input_tokens: 3, output_tokens: 2, total_tokens: 5, cost: 0.001, extra: "secret key"}});
    trace.finish(); trace.finish();
  }
  const rows = read();
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].requestId, rows[1].requestId);
  assert.equal(rows[0].actualModel, "vendor/model");
  assert.equal(rows[0].usage.cost, 0.001);
  assert.ok(rows[0].latencyMs >= 0);
  assert.doesNotMatch(JSON.stringify(rows), /secret/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("does not substitute estimates for missing usage or actual model", context => {
  const {file, read} = fixture(context);
  const trace = startRoutingTrace(file);
  trace.finish("http_429");
  assert.equal(read()[0].usage, null);
  assert.equal(read()[0].actualModel, null);
  assert.equal(read()[0].error, "http_429");
});

test("observes split SSE metadata while preserving every byte", async context => {
  const {file, read} = fixture(context);
  const trace = startRoutingTrace(file);
  const bytes = Buffer.from('data: {"type":"response.completed","response":{"id":"resp_2","model":"vendor/actual","status":"completed","usage":{"total_tokens":9}}}\r\n\r\ndata: [DONE]\n\n');
  async function* source() {for (let i = 0; i < bytes.length; i += 3) yield bytes.subarray(i, i + 3);}
  const output: Uint8Array[] = [];
  for await (const chunk of trace.stream(source(), new AbortController().signal)) output.push(chunk);
  assert.deepEqual(Buffer.concat(output), bytes);
  assert.equal(read()[0].actualModel, "vendor/actual");
  assert.equal(read()[0].usage.totalTokens, 9);
  assert.equal(read()[0].usage.inputTokens, null);
  assert.equal(read()[0].status, "completed");
});

test("records missing stream completion and transport errors without raw messages", async context => {
  const {file, read} = fixture(context);
  async function* empty() {yield Buffer.from(": heartbeat\n\n");}
  for await (const chunk of startRoutingTrace(file).stream(empty(), new AbortController().signal)) assert.ok(chunk);
  async function* failed() {throw new Error("secret network detail"); yield Buffer.alloc(0);}
  await assert.rejects(async () => {for await (const chunk of startRoutingTrace(file).stream(failed(), new AbortController().signal)) assert.ok(chunk);});
  assert.equal(read()[0].error, "stream_incomplete");
  assert.equal(read()[1].error, "stream_error");
  assert.doesNotMatch(JSON.stringify(read()), /secret/);
});

test("records cancellation when a consumer stops reading", async context => {
  const {file, read} = fixture(context);
  const controller = new AbortController();
  async function* source() {yield Buffer.from(": hello\n\n");}
  for await (const chunk of startRoutingTrace(file).stream(source(), controller.signal)) {
    assert.ok(chunk); controller.abort(); break;
  }
  assert.equal(read()[0].error, "cancelled_or_timeout");
});

test("reports storage failure without exposing paths or failing execution", context => {
  const {file} = fixture(context);
  fs.mkdirSync(file, {recursive: true});
  const messages: unknown[][] = [];
  context.mock.method(console, "error", (...args: unknown[]) => messages.push(args));
  assert.doesNotThrow(() => startRoutingTrace(file).finish());
  assert.deepEqual(messages, [["Routing trace could not be saved"]]);
});
