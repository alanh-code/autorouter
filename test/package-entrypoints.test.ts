import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("default startup and packaged entrypoint use the gateway", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.scripts.start, "node ./bin/gateway");
  assert.equal(manifest.scripts.start, manifest.scripts.gateway);
  assert.equal(manifest.bin["autorouter-gateway"], "./bin/gateway");
  assert.ok(manifest.files.includes("bin/gateway"));
  assert.ok(fs.existsSync(new URL("../bin/gateway", import.meta.url)));
  assert.deepEqual(Object.keys(manifest.bin), ["autorouter-gateway"]);
  assert.equal(manifest.dependencies, undefined);
  assert.ok(!manifest.files.includes("autorouter.config.json"));
});
