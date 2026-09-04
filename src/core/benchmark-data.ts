import {randomBytes} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {OpenRouterModel} from "../gateway/openrouter-adapter.ts";
import type {RequestTaskCategory} from "./request-classifier.ts";

const CACHE_VERSION = 1;

const TASK_BENCHMARKS = Object.freeze({
  coding: {source: "artificial_analysis", metric: "coding_index"},
  agentic: {source: "artificial_analysis", metric: "agentic_index"},
  general_reasoning: {source: "artificial_analysis", metric: "intelligence_index"},
  website: {source: "design_arena", category: "website", metric: "elo"},
  ui_components: {source: "design_arena", category: "uicomponent", metric: "elo"},
  game_development: {source: "design_arena", category: "gamedev", metric: "elo"},
  data_visualization: {source: "design_arena", category: "dataviz", metric: "elo"},
  three_d: {source: "design_arena", category: "3d", metric: "elo"},
  other: {source: "artificial_analysis", metric: "intelligence_index"}
} as const);

type ArtificialAnalysisScores = Readonly<{
  intelligenceIndex: number | null;
  codingIndex: number | null;
  agenticIndex: number | null;
}>;

type DesignArenaScore = Readonly<{
  arena: string;
  category: string;
  elo: number;
  winRate: number;
  rank: number;
}>;

type ModelBenchmarks = Readonly<{
  artificialAnalysis: ArtificialAnalysisScores | null;
  designArena: readonly DesignArenaScore[];
}>;

export type BenchmarkSnapshot = Readonly<{
  version: 1;
  updatedAt: string;
  models: Readonly<Record<string, ModelBenchmarks>>;
}>;

export type TaskBenchmark = Readonly<{
  source: "artificial_analysis" | "design_arena";
  metric: "intelligence_index" | "coding_index" | "agentic_index" | "elo";
  category: string | null;
  score: number;
}>;

type BenchmarkAdapter = Readonly<{
  listModels(args: {apiKey: string; signal?: AbortSignal}): Promise<readonly OpenRouterModel[]>;
}>;

export function getBenchmarkCachePath(homeDirectory = os.homedir()): string {
  return path.join(homeDirectory, ".autorouter", "benchmarks.json");
}

export async function syncBenchmarkSnapshot({
  adapter,
  apiKey,
  filePath = getBenchmarkCachePath(),
  signal,
  now = Date.now
}: {
  adapter: BenchmarkAdapter;
  apiKey: string;
  filePath?: string;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<BenchmarkSnapshot> {
  const models = await adapter.listModels({apiKey, signal});
  const snapshot = createBenchmarkSnapshot(models, new Date(now()).toISOString());
  writeBenchmarkSnapshot(filePath, snapshot);
  return snapshot;
}

export function createBenchmarkSnapshot(
  models: readonly OpenRouterModel[],
  updatedAt = new Date().toISOString()
): BenchmarkSnapshot {
  if (!Array.isArray(models)) {
    throw new Error("Benchmark model catalog must be an array");
  }
  const timestamp = normalizeTimestamp(updatedAt);
  const normalized: Record<string, ModelBenchmarks> = {};

  for (const model of models) {
    if (!model || typeof model !== "object" || typeof model.id !== "string" || !model.id.trim()) {
      throw new Error("Benchmark model catalog contains an invalid model");
    }
    if (Object.hasOwn(normalized, model.id)) {
      throw new Error(`Benchmark model catalog contains duplicate id: ${model.id}`);
    }
    const benchmarks = normalizeModelBenchmarks(model.benchmarks);
    if (hasBenchmark(benchmarks)) {
      normalized[model.id] = benchmarks;
    }
  }

  return deepFreeze({version: CACHE_VERSION, updatedAt: timestamp, models: normalized}) as BenchmarkSnapshot;
}

export function loadBenchmarkSnapshot(filePath = getBenchmarkCachePath()): BenchmarkSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Benchmark cache contains invalid JSON");
    }
    throw error;
  }

  const cache = requireRecord(value, "Benchmark cache must be an object");
  if (cache.version !== CACHE_VERSION) {
    throw new Error("Benchmark cache version is unsupported");
  }
  const models = requireRecord(cache.models, "Benchmark cache models must be an object");
  const normalizedModels: Record<string, ModelBenchmarks> = {};
  for (const [modelId, benchmarks] of Object.entries(models)) {
    if (!modelId.trim()) {
      throw new Error("Benchmark cache contains an invalid model id");
    }
    normalizedModels[modelId] = normalizeModelBenchmarks(benchmarks);
  }

  return deepFreeze({
    version: CACHE_VERSION,
    updatedAt: normalizeTimestamp(cache.updatedAt),
    models: normalizedModels
  }) as BenchmarkSnapshot;
}

export function getTaskBenchmark(
  snapshot: BenchmarkSnapshot,
  modelId: string,
  taskCategory: RequestTaskCategory
): TaskBenchmark | null {
  const benchmarks = snapshot.models[modelId];
  if (!benchmarks) {
    return null;
  }
  const mapping = TASK_BENCHMARKS[taskCategory];
  if (mapping.source === "artificial_analysis") {
    const scores = benchmarks.artificialAnalysis;
    const score = mapping.metric === "coding_index"
      ? scores?.codingIndex
      : mapping.metric === "agentic_index"
        ? scores?.agenticIndex
        : scores?.intelligenceIndex;

    return score === null || score === undefined
      ? null
      : Object.freeze({source: mapping.source, metric: mapping.metric, category: null, score});
  }

  const result = benchmarks.designArena.find(
    (score) => score.arena === "models" && score.category === mapping.category
  );
  return result
    ? Object.freeze({
      source: mapping.source,
      metric: mapping.metric,
      category: mapping.category,
      score: result.elo
    })
    : null;
}

function writeBenchmarkSnapshot(filePath: string, snapshot: BenchmarkSnapshot): void {
  const directoryPath = path.dirname(filePath);
  fs.mkdirSync(directoryPath, {recursive: true, mode: 0o700});
  fs.chmodSync(directoryPath, 0o700);
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;

  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(snapshot)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    fs.renameSync(temporaryPath, filePath);
    fs.chmodSync(filePath, 0o600);
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

function normalizeModelBenchmarks(value: unknown): ModelBenchmarks {
  const record = requireRecord(value, "Model benchmarks must be an object");
  const artificialAnalysis = record.artificialAnalysis === null
    ? null
    : normalizeArtificialAnalysis(record.artificialAnalysis);
  const designArena = Array.isArray(record.designArena)
    ? record.designArena.map(normalizeDesignArena)
    : (() => { throw new Error("Design Arena benchmarks must be an array"); })();

  return {
    artificialAnalysis,
    designArena
  };
}

function normalizeArtificialAnalysis(value: unknown): ArtificialAnalysisScores {
  const record = requireRecord(value, "Artificial Analysis benchmarks must be an object");
  return {
    intelligenceIndex: normalizeNullableNumber(record.intelligenceIndex, "intelligence index"),
    codingIndex: normalizeNullableNumber(record.codingIndex, "coding index"),
    agenticIndex: normalizeNullableNumber(record.agenticIndex, "agentic index")
  };
}

function normalizeDesignArena(value: unknown): DesignArenaScore {
  const record = requireRecord(value, "Design Arena benchmark must be an object");
  return {
    arena: normalizeString(record.arena, "Design Arena benchmark arena"),
    category: normalizeString(record.category, "Design Arena benchmark category"),
    elo: normalizeNumber(record.elo, "Design Arena ELO"),
    winRate: normalizeNumber(record.winRate, "Design Arena win rate"),
    rank: normalizeNumber(record.rank, "Design Arena rank")
  };
}

function hasBenchmark(value: ModelBenchmarks): boolean {
  const artificial = value.artificialAnalysis;
  return Boolean(value.designArena.length > 0
    || (artificial && (
      artificial.intelligenceIndex !== null
      || artificial.codingIndex !== null
      || artificial.agenticIndex !== null
    )));
}

function normalizeTimestamp(value: unknown): string {
  const timestamp = normalizeString(value, "Benchmark cache timestamp");
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new Error("Benchmark cache timestamp must be ISO-8601");
  }
  return timestamp;
}

function normalizeNullableNumber(value: unknown, label: string): number | null {
  return value === null ? null : normalizeNumber(value, label);
}

function normalizeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return value;
}

function normalizeString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function deepFreeze<T>(value: T): Readonly<T> {
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    if (nested && typeof nested === "object" && !Object.isFrozen(nested)) {
      deepFreeze(nested);
    }
  }
  return value;
}
