import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  configureUpstreamCredential,
  loadUpstreamCredential
} from "../src/gateway/index.js";

test("validates and stores an upstream credential privately", async (context) => {
  const filePath = createCredentialPath(context);
  const receivedRequests = [];

  const result = await configureUpstreamCredential({
    gateway: "openrouter",
    apiKey: " test-openrouter-key ",
    filePath,
    fetchImpl: async (url, options) => {
      receivedRequests.push({url, options});

      if (url.endsWith("/key")) {
        return Response.json({data: {label: "test-key"}});
      }

      return Response.json({data: [{id: "vendor/model-a"}, {id: "vendor/model-b"}]});
    }
  });

  assert.deepEqual(receivedRequests.map((request) => request.url), [
    "https://openrouter.ai/api/v1/key",
    "https://openrouter.ai/api/v1/models"
  ]);
  assert.equal(receivedRequests[0].options.headers.Authorization, "Bearer test-openrouter-key");
  assert.equal(receivedRequests[0].options.signal.aborted, false);
  assert.deepEqual(result, {gateway: "openrouter", modelCount: 2});
  assert.deepEqual(loadUpstreamCredential(filePath), {
    gateway: "openrouter",
    apiKey: "test-openrouter-key"
  });
  assert.equal(fs.statSync(path.dirname(filePath)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

test("replaces the active upstream and its credential", async (context) => {
  const filePath = createCredentialPath(context);
  const fetchImpl = async () => Response.json({data: [{id: "provider:model-a"}]});

  await configureUpstreamCredential({
    gateway: "openrouter",
    apiKey: "first-key",
    filePath,
    fetchImpl
  });
  await configureUpstreamCredential({
    gateway: "ramp-router",
    apiKey: "second-key",
    filePath,
    fetchImpl
  });

  assert.deepEqual(loadUpstreamCredential(filePath), {
    gateway: "ramp-router",
    apiKey: "second-key"
  });
});

test("does not store a credential rejected by the upstream", async (context) => {
  const filePath = createCredentialPath(context);

  await assert.rejects(
    configureUpstreamCredential({
      gateway: "openrouter",
      apiKey: "rejected-key",
      filePath,
      fetchImpl: async () => Response.json(
        {error: {code: "invalid_api_key"}},
        {status: 401}
      )
    }),
    /validation failed with status 401/
  );

  assert.equal(fs.existsSync(filePath), false);
});

test("rejects an empty or malformed upstream model catalog", async (context) => {
  const filePath = createCredentialPath(context);

  await assert.rejects(
    configureUpstreamCredential({
      gateway: "ramp-router",
      apiKey: "catalog-test-key",
      filePath,
      fetchImpl: async () => Response.json({data: []})
    }),
    /model catalog is invalid or empty/
  );

  assert.equal(fs.existsSync(filePath), false);
});

function createCredentialPath(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "autorouter-upstream-test-"));
  context.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  return path.join(directory, "settings", "upstream.json");
}
