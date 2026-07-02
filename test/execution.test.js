import test from "node:test";
import assert from "node:assert/strict";
import {runExecution} from "../src/execution.js";

test("runExecution completes model stage and final synthesis", async () => {
  process.env.AUTOROUTER_TEST_KEY = "test-key";
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, options) => {
    calls.push({url, options});
    const callNumber = calls.length;

    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: callNumber === 1 ? "stage result" : "final answer"
              }
            }
          ],
          usage: {
            prompt_tokens: callNumber === 1 ? 100 : 50,
            completion_tokens: callNumber === 1 ? 20 : 10
          }
        };
      }
    };
  };

  try {
    const config = {
      providers: {
        deepseek: {
          enabled: true,
          apiKeyEnv: "AUTOROUTER_TEST_KEY",
          apiBaseUrl: "https://example.invalid",
          models: []
        }
      },
      tools: {}
    };
    const activities = [];
    const result = await runExecution({
      config,
      execution: {
        task: "summarize something",
        baseModel: "Test Model",
        baseModelUsageText: "$0.000100",
        routes: [
          {
            stage: "summarize",
            kind: "summarize",
            goal: "Summarize",
            tools: [],
            modelLabel: "Test Model",
            modelName: "test-model",
            provider: "deepseek",
            pricing: {inputPerMillion: 1, outputPerMillion: 2},
            maxTokens: 100
          }
        ]
      },
      signal: new AbortController().signal,
      onActivity: (activity) => activities.push(activity)
    });

    assert.equal(calls.length, 2);
    assert.deepEqual(activities.map((activity) => activity.stage), ["prepare execution", "summarize", "finalize"]);
    assert.equal(result.lines[0], "final answer");
    assert.ok(result.lines.includes("[Cost Review]"));
    assert.ok(result.lines.some((line) => line.startsWith("stage 1: summarize")));
    assert.ok(result.lines.some((line) => line.startsWith("final: synthesize answer")));
    assert.ok(result.lines.some((line) => line.startsWith("total: ")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runExecution falls back to stage results when final synthesis is empty", async () => {
  process.env.AUTOROUTER_TEST_KEY = "test-key";
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, options) => {
    calls.push({url, options});
    const callNumber = calls.length;

    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: callNumber === 1 ? "stage result answer" : ""
              }
            }
          ],
          usage: {
            prompt_tokens: callNumber === 1 ? 100 : 50,
            completion_tokens: callNumber === 1 ? 20 : 0
          }
        };
      }
    };
  };

  try {
    const config = {
      providers: {
        kimi: {
          enabled: true,
          apiKeyEnv: "AUTOROUTER_TEST_KEY",
          apiBaseUrl: "https://example.invalid",
          models: []
        }
      },
      tools: {}
    };
    const activities = [];
    const result = await runExecution({
      config,
      execution: {
        task: "explain local agent privacy",
        baseModel: "Test Model",
        baseModelUsageText: "$0.000100",
        routes: [
          {
            stage: "explain privacy",
            kind: "explain",
            goal: "Explain",
            tools: [],
            modelLabel: "Kimi Test",
            modelName: "kimi-test",
            provider: "kimi",
            pricing: {inputPerMillion: 1, outputPerMillion: 2},
            maxTokens: 100
          }
        ]
      },
      signal: new AbortController().signal,
      onActivity: (activity) => activities.push(activity)
    });

    assert.equal(calls.length, 2);
    assert.deepEqual(activities.map((activity) => activity.detail), [
      "AutoRouter execution",
      "Kimi Test · $0.000140",
      "AutoRouter execution"
    ]);
    assert.equal(result.lines[0], "stage result answer");
    assert.ok(result.lines.includes("[Cost Review]"));
    assert.ok(result.lines.some((line) => line.includes("final synthesis unavailable: kimi API returned empty content")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
