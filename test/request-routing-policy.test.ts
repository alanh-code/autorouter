import test from "node:test";
import assert from "node:assert/strict";
import {createCanonicalInventory, selectModelDeterministically} from "../src/core/index.js";
import type {BenchmarkSnapshot} from "../src/core/benchmark-data.ts";
import type {RoutingRequirements} from "../src/core/request-routing-policy.ts";

const requirements: RoutingRequirements = {
  classification: {
    taskCategory: "coding",
    requiredCapabilities: {inputModalities: ["text"], outputModalities: ["text"], toolCalls: false}
  },
  upstream: "primary", estimatedInputTokens: 1_000, estimatedOutputTokens: 500
};

function model(id: string, price = 1, overrides: Record<string, unknown> = {}) {
  return {
    id: `vendor:${id}`, label: id,
    capabilities: {inputModalities: ["text"], outputModalities: ["text"], toolCalls: true, streaming: true},
    limits: {contextTokens: 10_000, maxOutputTokens: 2_000},
    pricing: {inputPerMillion: price, outputPerMillion: price},
    upstreams: {primary: {modelId: `vendor/${id}`, available: true}},
    ...overrides
  };
}

function snapshot(scores: Record<string, number | null> = {}): BenchmarkSnapshot {
  return {version: 1, updatedAt: "2026-01-01T00:00:00.000Z", models: Object.fromEntries(
    Object.entries(scores).map(([id, score]) => [`vendor/${id}`, {
      artificialAnalysis: {codingIndex: score, intelligenceIndex: null, agenticIndex: null},
      designArena: []
    }])
  )};
}

test("selects the highest task benchmark before considering cost", () => {
  const decision = selectModelDeterministically({
    inventory: createCanonicalInventory([model("a", 1), model("b", 10), model("c", 0)]),
    benchmarks: snapshot({a: 60, b: 80}), requirements
  });
  assert.equal(decision.modelId, "vendor:b");
  assert.equal(decision.upstreamModelId, "vendor/b");
  assert.equal(decision.mode, "benchmark");
  assert.equal(decision.candidates[0].estimatedCost, 0.015);
  assert.equal(decision.candidates.length, 2);
  assert.match(decision.reason, /coding_index/);
  assert.equal(Object.isFrozen(decision.candidates), true);
});

test("breaks equal scores by cost and model ID independently of inventory order", () => {
  const inventory = createCanonicalInventory([model("c", 2), model("b"), model("a")]);
  const benchmarks = snapshot({a: 60, b: 60, c: 60});
  const first = selectModelDeterministically({inventory, benchmarks, requirements});
  const second = selectModelDeterministically({inventory: [...inventory].reverse(), benchmarks, requirements});
  assert.equal(first.modelId, "vendor:a");
  assert.deepEqual(first, second);
});

test("uses a task-specific arena score instead of an unrelated coding score", () => {
  const benchmarks = snapshot({a: 99, b: 1});
  const withArena: BenchmarkSnapshot = {...benchmarks, models: {
    ...benchmarks.models,
    "vendor/b": {...benchmarks.models["vendor/b"], designArena: [
      {arena: "models", category: "website", elo: 1200, winRate: 50, rank: 1}
    ]}
  }};
  const decision = selectModelDeterministically({
    inventory: createCanonicalInventory([model("a"), model("b")]), benchmarks: withArena,
    requirements: {...requirements, classification: {...requirements.classification, taskCategory: "website"}}
  });
  assert.equal(decision.modelId, "vendor:b");
  assert.equal(decision.candidates[0].benchmark?.source, "design_arena");
});

test("filters unavailable models and insufficient capabilities or token limits", () => {
  const rejected = [
    model("offline", 0, {upstreams: {primary: {modelId: null, available: false}}}),
    model("small", 0, {limits: {contextTokens: 1_000, maxOutputTokens: 500}}),
    model("short", 0, {limits: {contextTokens: 10_000, maxOutputTokens: 100}}),
    ...["toolCalls", "streaming"].map((field) => model(field, 0, {
      capabilities: {inputModalities: ["text"], outputModalities: ["text"], toolCalls: true, streaming: true, [field]: false}
    })),
    model("image", 0, {capabilities: {inputModalities: ["image"], outputModalities: ["text"], toolCalls: true, streaming: true}})
  ];
  const decision = selectModelDeterministically({
    inventory: createCanonicalInventory([...rejected, model("valid")]), benchmarks: snapshot(),
    requirements: {...requirements, streaming: true, classification: {
      ...requirements.classification,
      requiredCapabilities: {...requirements.classification.requiredCapabilities, toolCalls: true}
    }}
  });
  assert.equal(decision.modelId, "vendor:valid");
  assert.equal(decision.candidates.length, 1);
});

test("falls back explicitly to cost only when no eligible task score exists", () => {
  const decision = selectModelDeterministically({
    inventory: createCanonicalInventory([model("a", 3), model("b", 1), model("unknown", 0, {pricing: null})]),
    benchmarks: snapshot(), requirements
  });
  assert.equal(decision.modelId, "vendor:b");
  assert.equal(decision.mode, "cost_only");
  assert.match(decision.reason, /No eligible model has a relevant benchmark/);
  assert.equal(decision.benchmarkUpdatedAt, snapshot().updatedAt);
});

test("preserves zero scores and unknown costs without inventing values", () => {
  const inventory = createCanonicalInventory([model("a", 0, {pricing: null}), model("b", 1)]);
  const decision = selectModelDeterministically({inventory, benchmarks: snapshot({a: 0}), requirements});
  assert.equal(decision.modelId, "vendor:a");
  assert.equal(decision.candidates[0].estimatedCost, null);
  const tied = selectModelDeterministically({inventory, benchmarks: snapshot({a: 0, b: 0}), requirements});
  assert.equal(tied.modelId, "vendor:b");
});

test("rejects missing evidence and invalid routing inputs", () => {
  assert.throws(() => selectModelDeterministically({
    inventory: createCanonicalInventory([model("a", 0, {pricing: null})]), benchmarks: snapshot(), requirements
  }), /No eligible model/);
  assert.throws(() => selectModelDeterministically({
    inventory: [], benchmarks: snapshot(), requirements: {...requirements, estimatedInputTokens: NaN}
  }), /token counts/);
});
