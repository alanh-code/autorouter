import test from "node:test";
import assert from "node:assert/strict";
import {parseModelId} from "../src/core/index.js";

test("parses canonical model IDs while preserving colons in upstream names", () => {
  assert.deepEqual(parseModelId("gateway:vendor:model"), {provider: "gateway", model: "vendor:model"});
  assert.deepEqual(parseModelId("unqualified"), {provider: "", model: "unqualified"});
});
