import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  generateLocalApiKey,
  loadOrCreateLocalApiKey,
  rotateLocalApiKey
} from "../src/gateway/index.js";

test("generates a distinct local API key with the expected prefix", () => {
  const first = generateLocalApiKey();
  const second = generateLocalApiKey();

  assert.match(first, /^ar_local_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
});

test("creates and reuses a private local API key file", (context) => {
  const temporaryDirectory = createTemporaryDirectory(context);
  const filePath = path.join(temporaryDirectory, "credentials", "local-api-key");
  let generationCount = 0;
  const generateKey = () => `ar_local_generated-${++generationCount}`;

  const first = loadOrCreateLocalApiKey({filePath, generateKey});
  const second = loadOrCreateLocalApiKey({filePath, generateKey});

  assert.equal(first, "ar_local_generated-1");
  assert.equal(second, first);
  assert.equal(generationCount, 1);
  assert.equal(fs.statSync(path.dirname(filePath)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

test("rotates and invalidates the stored local API key", (context) => {
  const temporaryDirectory = createTemporaryDirectory(context);
  const filePath = path.join(temporaryDirectory, "credentials", "local-api-key");
  const original = loadOrCreateLocalApiKey({filePath, generateKey: () => "ar_local_original"});
  const rotated = rotateLocalApiKey({filePath, generateKey: () => "ar_local_rotated"});

  assert.notEqual(rotated, original);
  assert.equal(loadOrCreateLocalApiKey({filePath}), rotated);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

function createTemporaryDirectory(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "autorouter-auth-test-"));
  context.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  return directory;
}
