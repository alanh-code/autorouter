import test from "node:test";
import assert from "node:assert/strict";
import {
  createGatewayServer,
  DEFAULT_GATEWAY_HOST,
  resolveGatewayHost
} from "../src/gateway/index.js";

test("binds the gateway to IPv4 loopback by default", () => {
  assert.equal(DEFAULT_GATEWAY_HOST, "127.0.0.1");
  assert.equal(resolveGatewayHost(undefined), "127.0.0.1");
});

test("uses a non-loopback host only when explicitly configured", () => {
  assert.equal(resolveGatewayHost(" 0.0.0.0 "), "0.0.0.0");
});

test("rejects an empty configured gateway host", () => {
  assert.throws(
    () => resolveGatewayHost("   "),
    /AUTOROUTER_HOST must not be empty/
  );
});

test("lists configured models with the OpenAI model schema", async () => {
  const server = createGatewayServer({
    models: [{id: "vendor:model-a", provider: "vendor"}],
    now: () => 1_700_000_000_000
  });

  await withServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: {Authorization: "Bearer local-test-key"}
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^application\/json/);
    assert.deepEqual(await response.json(), {
      object: "list",
      data: [
        {
          id: "vendor:model-a",
          object: "model",
          created: 1_700_000_000,
          owned_by: "vendor"
        }
      ]
    });
  });
});

test("returns a buffered OpenAI response object", async () => {
  let receivedRequest;
  const server = createGatewayServer({
    handleResponse: async (request, context) => {
      receivedRequest = request;
      assert.equal(context.signal.aborted, false);
      return {
        model: "vendor:selected-model",
        outputText: "Hello from the gateway.",
        usage: {input_tokens: 3, output_tokens: 5, total_tokens: 8}
      };
    },
    createId: (prefix) => `${prefix}_test`,
    now: () => 1_700_000_000_000
  });

  await withServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({model: "autorouter", input: "Hello"})
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(receivedRequest, {model: "autorouter", input: "Hello"});
    assert.equal(body.id, "resp_test");
    assert.equal(body.object, "response");
    assert.equal(body.status, "completed");
    assert.equal(body.model, "vendor:selected-model");
    assert.equal(body.output[0].id, "msg_test");
    assert.equal(body.output[0].content[0].text, "Hello from the gateway.");
    assert.deepEqual(body.usage, {input_tokens: 3, output_tokens: 5, total_tokens: 8});
  });
});

test("streams typed Responses API server-sent events", async () => {
  const server = createGatewayServer({
    handleResponse: async () => ({model: "vendor:model-a", outputText: "Hello"}),
    createId: (prefix) => `${prefix}_stream`,
    now: () => 1_700_000_000_000
  });

  await withServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({model: "autorouter", input: "Hello", stream: true})
    });
    const events = parseServerSentEvents(await response.text());

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/event-stream/);
    assert.deepEqual(events.map((event) => event.name), [
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed"
    ]);
    assert.equal(events[4].data.delta, "Hello");
    assert.equal(events.at(-1).data.response.status, "completed");
    assert.deepEqual(events.map((event) => event.data.sequence_number), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

test("returns OpenAI-shaped validation errors", async () => {
  const server = createGatewayServer();

  await withServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({model: "autorouter"})
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(body, {
      error: {
        message: "input is required",
        type: "invalid_request_error",
        param: "input",
        code: "invalid_request_error"
      }
    });
  });
});

test("reports an unavailable response handler without exposing internals", async () => {
  const server = createGatewayServer();

  await withServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({model: "autorouter", input: "Hello"})
    });
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(body.error.code, "gateway_not_ready");
    assert.equal(body.error.message, "No response handler is configured");
  });
});

test("hides unexpected response handler errors", async () => {
  const server = createGatewayServer({
    handleResponse: async () => {
      throw new Error("private upstream detail");
    }
  });

  await withServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({model: "autorouter", input: "Hello"})
    });
    const body = await response.json();

    assert.equal(response.status, 500);
    assert.equal(body.error.code, "server_error");
    assert.equal(body.error.message, "Internal server error");
  });
});

async function withServer(server, run) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

function parseServerSentEvents(text) {
  return text.trim().split("\n\n").map((block) => {
    const lines = block.split("\n");
    const name = lines.find((line) => line.startsWith("event: ")).slice(7);
    const data = JSON.parse(lines.find((line) => line.startsWith("data: ")).slice(6));
    return {name, data};
  });
}
