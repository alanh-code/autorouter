import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createBenchmarkSnapshot,
  getBenchmarkCachePath,
  getTaskBenchmark,
  loadBenchmarkSnapshot,
  syncBenchmarkSnapshot
} from "../src/core/index.js";
import type {OpenRouterModel} from "../src/gateway/openrouter-adapter.ts";

test("maps request categories to task-specific benchmark scores", () => {
  const snapshot = createBenchmarkSnapshot([createModel()], "2026-09-03T12:00:00.000Z");

  assert.deepEqual(getTaskBenchmark(snapshot, "vendor/model-a", "coding"), {
    source: "artificial_analysis",
    metric: "coding_index",
    category: null,
    score: 72
  });
  assert.deepEqual(getTaskBenchmark(snapshot, "vendor/model-a", "website"), {
    source: "design_arena",
    metric: "elo",
    category: "website",
    score: 1260
  });
  assert.deepEqual(getTaskBenchmark(snapshot, "vendor/model-a", "other"), {
    source: "artificial_analysis",
    metric: "intelligence_index",
    category: null,
    score: 68
  });
  assert.equal(getTaskBenchmark(snapshot, "missing/model", "coding"), null);
});

test("syncs benchmark data through the model adapter and loads the local cache", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "autorouter-benchmarks-"));
  context.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const filePath = path.join(directory, "state", "benchmarks.json");
  const calls: Array<{apiKey: string; signal?: AbortSignal}> = [];
  const signal = new AbortController().signal;
  const adapter = {
    async listModels(args: {apiKey: string; signal?: AbortSignal}) {
      calls.push(args);
      return [createModel()];
    }
  };

  const saved = await syncBenchmarkSnapshot({
    adapter,
    apiKey: "test-key",
    filePath,
    signal,
    now: () => Date.parse("2026-09-03T12:00:00.000Z")
  });
  const loaded = loadBenchmarkSnapshot(filePath);

  assert.deepEqual(calls, [{apiKey: "test-key", signal}]);
  assert.deepEqual(loaded, saved);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  assert.equal(Object.isFrozen(loaded), true);
  assert.equal(getBenchmarkCachePath(directory), path.join(directory, ".autorouter", "benchmarks.json"));
});

test("omits models without benchmark evidence", () => {
  const snapshot = createBenchmarkSnapshot([createModel({
    benchmarks: {artificialAnalysis: null, designArena: []}
  })]);

  assert.deepEqual(snapshot.models, {});
});

function createModel(overrides: Partial<OpenRouterModel> = {}): OpenRouterModel {
  return {
    id: "vendor/model-a",
    name: "Model A",
    provider: "vendor",
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportedParameters: ["tools"],
    contextTokens: 128_000,
    maxOutputTokens: 8_000,
    promptPricePerToken: 0.000001,
    completionPricePerToken: 0.000002,
    benchmarks: {
      artificialAnalysis: {
        intelligenceIndex: 68,
        codingIndex: 72,
        agenticIndex: 61
      },
      designArena: [{
        arena: "models",
        category: "website",
        elo: 1260,
        winRate: 55,
        rank: 2
      }]
    },
    ...overrides
  };
}
