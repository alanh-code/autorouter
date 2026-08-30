import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeAnalyzedStages,
  normalizeClarificationQuestion
} from "../src/legacy/terminal/router/analysis.js";

test("normalizes model clarification question", () => {
  assert.equal(
    normalizeClarificationQuestion({clarification: "Which city do you mean"}),
    "Which city do you mean?"
  );
});

test("normalizes stages and drops unknown tools", () => {
  assert.deepEqual(
    normalizeAnalyzedStages([
      {
        label: " fetch weather data ",
        kind: " Search ",
        goal: "Get weather",
        modelId: "deepseek:deepseek-v4-flash",
        modelChoiceReason: "Chosen because web search handles freshness and the stage only needs concise synthesis.",
        tools: ["web_search", "unknown_tool", "web_search"]
      }
    ]),
    [
      {
        label: "fetch weather data",
        kind: "search",
        goal: "Get weather",
        modelId: "deepseek:deepseek-v4-flash",
        modelChoiceReason: "Chosen because web search handles freshness and the stage only needs concise synthesis.",
        tools: ["web_search"]
      }
    ]
  );
});
