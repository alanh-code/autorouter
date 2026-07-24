import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {
  LOCAL_ENV_FILE,
  MAX_CODEBASE_CONTEXT_CHARS,
  MAX_FILE_EDITS_PER_STAGE,
  MAX_FILE_WRITES_PER_STAGE,
  MAX_LOCAL_FILE_CHARS,
  MAX_WORKSPACE_SNAPSHOT_FILES
} from "../constants.js";
import {getErrorMessage, limitInputText} from "../utils/text.js";

export function getWorkspaceSnapshotForAnalysis(root) {
  const files = listCodebaseFiles(root);
  const topLevelEntries = getTopLevelWorkspaceEntries(root);

  return [
    `Root: ${root}`,
    `Readable project files found: ${files.length}`,
    topLevelEntries.length > 0 ? `Top level entries: ${topLevelEntries.join(", ")}` : "Top level entries: none readable",
    "",
    "Readable file tree sample:",
    ...files.slice(0, MAX_WORKSPACE_SNAPSHOT_FILES).map((file) => file.relative),
    files.length > MAX_WORKSPACE_SNAPSHOT_FILES ? `... ${files.length - MAX_WORKSPACE_SNAPSHOT_FILES} more files omitted` : ""
  ].filter(Boolean).join("\n");
}

export function inspectLocalCodebase(root) {
  const files = listCodebaseFiles(root);
  const selectedFiles = selectCodebaseFiles(files);
  const parts = [
    `Current working directory: ${root}`,
    "",
    "File tree:",
    ...files.slice(0, 120).map((file) => file.relative),
    files.length > 120 ? `... ${files.length - 120} more files omitted` : "",
    "",
    "Key file excerpts:",
    ...selectedFiles.map((file) => formatLocalFileExcerpt(root, file.relative))
  ].filter(Boolean);

  return {
    provider: "local",
    toolLabel: "Local Codebase",
    toolName: "local.codebase",
    root,
    fileCount: files.length,
    usageText: "$0.000000",
    content: limitInputText(parts.join("\n"), MAX_CODEBASE_CONTEXT_CHARS)
  };
}

export function applyFileEditPlan(root, edits) {
  const normalized = normalizeFileEdits(edits);
  const applied = [];
  const skipped = [];

  for (const edit of normalized.slice(0, MAX_FILE_EDITS_PER_STAGE)) {
    const target = resolveWorkspaceFile(root, edit.file);

    if (!target.ok) {
      skipped.push({file: edit.file, reason: target.reason});
      continue;
    }

    let before = "";

    try {
      before = fs.readFileSync(target.absolutePath, "utf8");
    } catch {
      skipped.push({file: edit.file, reason: "file could not be read"});
      continue;
    }

    if (!before.includes(edit.old)) {
      skipped.push({file: target.relativePath, reason: "old text was not found"});
      continue;
    }

    const script = buildPerlReplacementScript(edit.old, edit.new);
    const result = spawnSync("perl", ["-0pi", "-e", script, target.absolutePath], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    });

    if (result.error) {
      skipped.push({file: target.relativePath, reason: result.error.message});
      continue;
    }

    if (result.status !== 0) {
      skipped.push({file: target.relativePath, reason: result.stderr?.trim() || `perl exited with ${result.status}`});
      continue;
    }

    const replacements = parsePerlReplacementCount(result.stderr);
    applied.push({
      file: target.relativePath,
      description: edit.description,
      replacements
    });
  }

  if (normalized.length > MAX_FILE_EDITS_PER_STAGE) {
    skipped.push({
      file: "additional edits",
      reason: `${normalized.length - MAX_FILE_EDITS_PER_STAGE} edits skipped by per-stage limit`
    });
  }

  return {
    total: normalized.length,
    applied,
    skipped
  };
}

export function formatFileEditResult(result) {
  const lines = [];

  if (result.applied.length === 0) {
    lines.push("No file edits were applied.");
  } else {
    lines.push(`Applied ${result.applied.length} file edits.`);
    lines.push("Edited files:");
    result.applied.forEach((edit) => {
      const count = Number.isFinite(edit.replacements) ? `${edit.replacements} replacements` : "replacement count unavailable";
      lines.push(`${edit.file}: ${edit.description} (${count})`);
    });
  }

  if (result.skipped.length > 0) {
    lines.push("");
    lines.push("Skipped edits:");
    result.skipped.forEach((edit) => {
      lines.push(`${edit.file}: ${edit.reason}`);
    });
  }

  return lines.join("\n");
}

export function applyFileWritePlan(root, files) {
  const normalized = normalizeFileWrites(files);
  const created = [];
  const skipped = [];

  for (const file of normalized.slice(0, MAX_FILE_WRITES_PER_STAGE)) {
    const target = resolveWorkspaceWritePath(root, file.file);

    if (!target.ok) {
      skipped.push({file: file.file, reason: target.reason});
      continue;
    }

    if (fs.existsSync(target.absolutePath)) {
      skipped.push({file: target.relativePath, reason: "file already exists"});
      continue;
    }

    try {
      fs.mkdirSync(path.dirname(target.absolutePath), {recursive: true});
      fs.writeFileSync(target.absolutePath, file.content, "utf8");
    } catch (error) {
      skipped.push({file: target.relativePath, reason: getErrorMessage(error)});
      continue;
    }

    created.push({
      file: target.relativePath,
      description: file.description,
      bytes: Buffer.byteLength(file.content, "utf8")
    });
  }

  if (normalized.length > MAX_FILE_WRITES_PER_STAGE) {
    skipped.push({
      file: "additional files",
      reason: `${normalized.length - MAX_FILE_WRITES_PER_STAGE} files skipped by per-stage limit`
    });
  }

  return {
    total: normalized.length,
    created,
    skipped
  };
}

export function formatFileWriteResult(result) {
  const lines = [];

  if (result.created.length === 0) {
    lines.push("No files were created.");
  } else {
    lines.push(`Created ${result.created.length} files.`);
    lines.push("Created files:");
    result.created.forEach((file) => {
      lines.push(`${file.file}: ${file.description} (${file.bytes} bytes)`);
    });
  }

  if (result.skipped.length > 0) {
    lines.push("");
    lines.push("Skipped files:");
    result.skipped.forEach((file) => {
      lines.push(`${file.file}: ${file.reason}`);
    });
  }

  return lines.join("\n");
}

function getTopLevelWorkspaceEntries(root) {
  try {
    return fs.readdirSync(root, {withFileTypes: true})
      .filter((entry) => !shouldSkipWorkspaceEntry(entry.name))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .slice(0, 40)
      .map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.name);
  } catch {
    return [];
  }
}

function listCodebaseFiles(root) {
  const results = [];

  function walk(directory, depth = 0) {
    if (depth > 4 || results.length >= 240) {
      return;
    }

    let entries = [];

    try {
      entries = fs.readdirSync(directory, {withFileTypes: true});
    } catch {
      return;
    }

    entries
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .forEach((entry) => {
        if (shouldSkipWorkspaceEntry(entry.name)) {
          return;
        }

        const fullPath = path.join(directory, entry.name);
        const relative = path.relative(root, fullPath);

        if (entry.isDirectory()) {
          walk(fullPath, depth + 1);
          return;
        }

        if (!entry.isFile() || !isReadableProjectFile(entry.name)) {
          return;
        }

        results.push({relative});
      });
  }

  walk(root);
  return results;
}

function shouldSkipWorkspaceEntry(name) {
  const ignoredDirectories = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".turbo"]);
  const ignoredFiles = new Set([LOCAL_ENV_FILE, ".env", ".env.production", ".env.development", "package-lock.json"]);

  return ignoredDirectories.has(name) || ignoredFiles.has(name) || name.startsWith(".env.");
}

function selectCodebaseFiles(files) {
  const priority = [
    "package.json",
    "README.md",
    "autorouter.config.json",
    "bin/auto"
  ];
  const byName = new Map(files.map((file) => [file.relative, file]));
  const selected = priority.map((name) => byName.get(name)).filter(Boolean);
  const seen = new Set(selected.map((file) => file.relative));

  for (const file of files) {
    if (selected.length >= 10) {
      break;
    }

    if (!seen.has(file.relative)) {
      selected.push(file);
      seen.add(file.relative);
    }
  }

  return selected;
}

function formatLocalFileExcerpt(root, relativePath) {
  const fullPath = path.join(root, relativePath);

  try {
    const content = fs.readFileSync(fullPath, "utf8");
    return [`File: ${relativePath}`, limitInputText(content, MAX_LOCAL_FILE_CHARS)].join("\n");
  } catch {
    return `File: ${relativePath}\n[unreadable]`;
  }
}

function normalizeFileEdits(edits) {
  if (!Array.isArray(edits)) {
    return [];
  }

  return edits
    .map((edit) => ({
      file: String(edit?.file ?? "").trim(),
      old: typeof edit?.old === "string" ? edit.old : "",
      new: typeof edit?.new === "string" ? edit.new : "",
      description: String(edit?.description ?? "updated file").trim().slice(0, 120)
    }))
    .filter((edit) => edit.file && edit.old && edit.old.length <= 8000 && edit.new.length <= 20000);
}

function resolveWorkspaceFile(root, filePath) {
  const absolutePath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(root, filePath);
  const relativePath = path.relative(root, absolutePath);

  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return {ok: false, reason: "path is outside the current working directory"};
  }

  const segments = relativePath.split(path.sep);

  if (segments.some((segment) => shouldSkipWorkspaceEntry(segment))) {
    return {ok: false, reason: "path is ignored for safety"};
  }

  let stat = null;

  try {
    stat = fs.statSync(absolutePath);
  } catch {
    return {ok: false, reason: "file does not exist"};
  }

  if (!stat.isFile()) {
    return {ok: false, reason: "path is not a file"};
  }

  if (!isReadableProjectFile(path.basename(relativePath))) {
    return {ok: false, reason: "file type is not editable by Autorouter"};
  }

  return {ok: true, absolutePath, relativePath};
}

function buildPerlReplacementScript(oldText, newText) {
  return [
    `my $old = ${toPerlSingleQuotedString(oldText)};`,
    `my $new = ${toPerlSingleQuotedString(newText)};`,
    "my $count = s/\\Q$old\\E/$new/g;",
    "print STDERR \"autorouter_replacements=$count\\n\";"
  ].join("\n");
}

function toPerlSingleQuotedString(value) {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function parsePerlReplacementCount(stderr) {
  const match = String(stderr ?? "").match(/autorouter_replacements=(\d+)/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function normalizeFileWrites(files) {
  if (!Array.isArray(files)) {
    return [];
  }

  return files
    .map((file) => ({
      file: String(file?.file ?? "").trim(),
      content: typeof file?.content === "string" ? file.content : "",
      description: String(file?.description ?? "created file").trim().slice(0, 120)
    }))
    .filter((file) => file.file && file.content.length <= 50000);
}

function resolveWorkspaceWritePath(root, filePath) {
  const absolutePath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(root, filePath);
  const relativePath = path.relative(root, absolutePath);

  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return {ok: false, reason: "path is outside the current working directory"};
  }

  const segments = relativePath.split(path.sep);

  if (segments.some((segment) => shouldSkipWorkspaceEntry(segment))) {
    return {ok: false, reason: "path is ignored for safety"};
  }

  if (!isReadableProjectFile(path.basename(relativePath))) {
    return {ok: false, reason: "file type is not writable by Autorouter"};
  }

  return {ok: true, absolutePath, relativePath};
}

function isReadableProjectFile(fileName) {
  const extension = path.extname(fileName).toLowerCase();
  const allowedExtensions = new Set([
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".json",
    ".md",
    ".txt",
    ".yml",
    ".yaml",
    ".toml",
    ".css",
    ".html"
  ]);

  return allowedExtensions.has(extension) || !extension;
}
