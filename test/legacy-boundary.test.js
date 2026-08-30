import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {fileURLToPath} from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDirectory, "..");
const sourceRoot = path.join(projectRoot, "src");
const legacyRoot = path.join(sourceRoot, "legacy");

test("the CLI enters the application through the legacy terminal boundary", async () => {
  const cliSource = fs.readFileSync(path.join(projectRoot, "bin", "auto"), "utf8");
  const legacyEntry = await import("../src/legacy/terminal/index.js");

  assert.match(cliSource, /src\/legacy\/terminal\/index\.js/);
  assert.equal(typeof legacyEntry.main, "function");
});

test("reusable source modules do not import the legacy terminal runtime", () => {
  const sourceFiles = listJavaScriptFiles(sourceRoot)
    .filter((filePath) => !filePath.startsWith(`${legacyRoot}${path.sep}`));

  for (const filePath of sourceFiles) {
    const source = fs.readFileSync(filePath, "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*legacy\/terminal[^"']*["']/);
  }
});

function listJavaScriptFiles(directory) {
  return fs.readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      return listJavaScriptFiles(entryPath);
    }

    return entry.isFile() && entry.name.endsWith(".js") ? [entryPath] : [];
  });
}
