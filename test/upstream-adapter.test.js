import test from "node:test";
import assert from "node:assert/strict";
import {
  defineUpstreamAdapter,
  UPSTREAM_ADAPTER_METHODS,
  UpstreamGatewayError
} from "../src/gateway/index.js";

test("defines a complete immutable upstream adapter", () => {
  const adapter = defineUpstreamAdapter(createAdapter());

  assert.equal(adapter.id, "test-gateway");
  assert.equal(adapter.baseUrl, "https://gateway.example/v1");
  assert.equal(Object.isFrozen(adapter), true);

  for (const method of UPSTREAM_ADAPTER_METHODS) {
    assert.equal(typeof adapter[method], "function");
  }
});

test("rejects incomplete or insecure upstream adapters", () => {
  const incomplete = createAdapter();
  delete incomplete.streamResponse;

  assert.throws(
    () => defineUpstreamAdapter(incomplete),
    /must implement streamResponse\(\)/
  );
  assert.throws(
    () => defineUpstreamAdapter(createAdapter({baseUrl: "http://gateway.example"})),
    /must use HTTPS/
  );
});

test("represents normalized classified upstream errors", () => {
  const error = new UpstreamGatewayError("Gateway is unavailable", {
    kind: "unavailable",
    statusCode: 503,
    providerCode: "service_unavailable",
    requestId: "request-test",
    retryable: true
  });

  assert.equal(error.name, "UpstreamGatewayError");
  assert.equal(error.kind, "unavailable");
  assert.equal(error.statusCode, 503);
  assert.equal(error.providerCode, "service_unavailable");
  assert.equal(error.requestId, "request-test");
  assert.equal(error.retryable, true);
  assert.throws(
    () => new UpstreamGatewayError("Unknown", {kind: "invented"}),
    /Unsupported upstream error kind/
  );
});

function createAdapter(overrides = {}) {
  const methods = Object.fromEntries(
    UPSTREAM_ADAPTER_METHODS.map((method) => [method, () => {}])
  );

  return {
    id: " test-gateway ",
    baseUrl: "https://gateway.example/v1/",
    ...methods,
    ...overrides
  };
}
