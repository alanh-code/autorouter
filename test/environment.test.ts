import test from "node:test";
import type {TestContext} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {loadLocalEnv} from "../src/gateway/environment.ts";

function fixture(context: TestContext, content?: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-env-"));
  context.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const filePath = path.join(directory, ".env.local");
  if (content !== undefined) fs.writeFileSync(filePath, content);
  return filePath;
}

test("environment loading is optional when the local file is absent", context => {
  const environment = {};
  loadLocalEnv(fixture(context), environment);
  assert.deepEqual(environment, {});
});

test("loads quoted values, embedded equals and CRLF without changing process environment", context => {
  const filePath = fixture(context, '# comment\r\n\r\ninvalid\r\n=ignored\r\nAUTOROUTER_UPSTREAM_API_KEY="test=value"\r\nAUTOROUTER_PORT=\x278787\x27\r\nEMPTY=\r\n');
  const environment = {};
  loadLocalEnv(filePath, environment);
  assert.deepEqual(environment, {AUTOROUTER_UPSTREAM_API_KEY: "test=value", AUTOROUTER_PORT: "8787", EMPTY: ""});
});

test("preserves existing environment overrides and fills empty values", context => {
  const filePath = fixture(context, "AUTOROUTER_PORT=8787\nAUTOROUTER_UPSTREAM_API_KEY=test-key\n");
  const environment = {AUTOROUTER_PORT: "9000", AUTOROUTER_UPSTREAM_API_KEY: ""};
  loadLocalEnv(filePath, environment);
  assert.deepEqual(environment, {AUTOROUTER_PORT: "9000", AUTOROUTER_UPSTREAM_API_KEY: "test-key"});
});
