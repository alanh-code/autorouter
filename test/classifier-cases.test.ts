import test from "node:test";
import assert from "node:assert/strict";
import {classifierCases} from "./fixtures/classifier-cases.ts";
import {REQUEST_TASK_CATEGORIES} from "../src/core/request-classifier.ts";
import {cases as acceptanceCases} from "./fixtures/classifier-acceptance.ts";

test("classifier development cases have unique inputs, valid labels, and review rationales", () => {
  assert.equal(classifierCases.length, 30);
  assert.equal(new Set(classifierCases.map(value => value.id)).size, 30);
  assert.equal(new Set(classifierCases.map(value => value.input)).size, 30);
  for (const value of classifierCases) {
    assert.ok(value.input.trim());
    assert.ok(value.rationale.trim());
    assert.ok(REQUEST_TASK_CATEGORIES.includes(value.expected));
  }
  assert.deepEqual(new Set(classifierCases.map(value => value.expected)), new Set(REQUEST_TASK_CATEGORIES));
});

test("classifier acceptance cases are distinct from development cases and cover every category", () => {
  assert.equal(acceptanceCases.length, 30);
  assert.equal(new Set(acceptanceCases.map(value => value.id)).size, 30);
  const inputs = [...classifierCases, ...acceptanceCases].map(value => value.input);
  assert.equal(new Set(inputs).size, 60);
  assert.deepEqual(new Set(acceptanceCases.map(value => value.expected)), new Set(REQUEST_TASK_CATEGORIES));
});
