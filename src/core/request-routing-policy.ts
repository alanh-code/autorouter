import {getTaskBenchmark} from "./benchmark-data.ts";
import type {BenchmarkSnapshot, TaskBenchmark} from "./benchmark-data.ts";
import type {CanonicalModel} from "./canonical-inventory.ts";
import {REQUEST_TASK_CATEGORIES} from "./request-classifier.ts";
import type {RequestClassification} from "./request-classifier.ts";

export type RoutingRequirements = Readonly<{
  classification: Pick<RequestClassification, "taskCategory" | "requiredCapabilities">;
  upstream: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  streaming?: boolean;
  minContextTokens?: number;
  minOutputTokens?: number;
}>;

type Candidate = Readonly<{
  modelId: string;
  upstreamModelId: string;
  benchmark: TaskBenchmark | null;
  estimatedCost: number | null;
}>;

export type RoutingDecision = Readonly<{
  modelId: string;
  upstreamModelId: string;
  mode: "benchmark" | "cost_only";
  benchmarkUpdatedAt: string;
  reason: string;
  candidates: readonly Candidate[];
}>;

export function selectModelDeterministically({inventory, benchmarks, requirements}: {
  inventory: readonly CanonicalModel[];
  benchmarks: BenchmarkSnapshot;
  requirements: RoutingRequirements;
}): RoutingDecision {
  validateRequirements(requirements);
  const eligible: Candidate[] = [];
  for (const model of inventory) {
    const upstream = model.upstreams[requirements.upstream];
    if (!model.available || !upstream?.available || !upstream.modelId
      || !meetsCapabilities(model, requirements)) {
      continue;
    }
    eligible.push(Object.freeze({
      modelId: model.id,
      upstreamModelId: upstream.modelId,
      benchmark: getTaskBenchmark(benchmarks, upstream.modelId, requirements.classification.taskCategory),
      estimatedCost: estimateCost(model, requirements)
    }));
  }

  const measured = eligible.filter((candidate) => candidate.benchmark !== null);
  const mode = measured.length > 0 ? "benchmark" : "cost_only";
  const candidates = mode === "benchmark"
    ? measured
    : eligible.filter((candidate) => candidate.estimatedCost !== null);
  candidates.sort((left, right) => {
    const scoreOrder = (right.benchmark?.score ?? 0) - (left.benchmark?.score ?? 0);
    if (scoreOrder !== 0) return scoreOrder;
    if (left.estimatedCost === null && right.estimatedCost !== null) return 1;
    if (right.estimatedCost === null && left.estimatedCost !== null) return -1;
    const costOrder = (left.estimatedCost ?? 0) - (right.estimatedCost ?? 0);
    return costOrder || (left.modelId < right.modelId ? -1 : left.modelId > right.modelId ? 1 : 0);
  });
  const selected = candidates[0];
  if (!selected) {
    throw new Error("No eligible model has a relevant benchmark or complete pricing data");
  }

  const reason = selected.benchmark
    ? `Selected ${selected.modelId} by ${selected.benchmark.source}/${selected.benchmark.category ?? selected.benchmark.metric}; ties use estimated cost, then model ID.`
    : `No eligible model has a relevant benchmark; selected ${selected.modelId} by estimated cost, then model ID.`;
  return Object.freeze({
    modelId: selected.modelId,
    upstreamModelId: selected.upstreamModelId,
    mode,
    benchmarkUpdatedAt: benchmarks.updatedAt,
    reason,
    candidates: Object.freeze(candidates)
  });
}

function meetsCapabilities(model: CanonicalModel, requirements: RoutingRequirements): boolean {
  const required = requirements.classification.requiredCapabilities;
  return required.inputModalities.every((value) => model.capabilities.inputModalities.includes(value))
    && required.outputModalities.every((value) => model.capabilities.outputModalities.includes(value))
    && (!required.toolCalls || model.capabilities.toolCalls)
    && (!requirements.streaming || model.capabilities.streaming)
    && model.limits.contextTokens >= Math.max(
      requirements.minContextTokens ?? 0,
      requirements.estimatedInputTokens + requirements.estimatedOutputTokens
    )
    && model.limits.maxOutputTokens >= Math.max(
      requirements.minOutputTokens ?? 0, requirements.estimatedOutputTokens
    );
}

function estimateCost(model: CanonicalModel, requirements: RoutingRequirements): number | null {
  const input = model.pricing?.inputPerMillion;
  const output = model.pricing?.outputPerMillion;
  if (input === undefined || output === undefined) return null;
  const cost = input / 1_000_000 * requirements.estimatedInputTokens
    + output / 1_000_000 * requirements.estimatedOutputTokens;
  return Number.isFinite(cost) ? cost : null;
}

function validateRequirements(value: RoutingRequirements): void {
  if (!value || typeof value.upstream !== "string" || !value.upstream.trim()) {
    throw new Error("Routing upstream is required");
  }
  for (const count of [value.estimatedInputTokens, value.estimatedOutputTokens,
    value.minContextTokens ?? 0, value.minOutputTokens ?? 0]) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error("Routing token counts must be non-negative safe integers");
    }
  }
  const classification = value.classification;
  if (!classification || !REQUEST_TASK_CATEGORIES.includes(classification.taskCategory)) {
    throw new Error("Routing task category is unsupported");
  }
  const capabilities = classification.requiredCapabilities;
  if (!capabilities || typeof capabilities.toolCalls !== "boolean"
    || [capabilities.inputModalities, capabilities.outputModalities].some(
      (items) => !Array.isArray(items) || !items.length
        || items.some((item) => typeof item !== "string" || !item.trim())
    ) || (value.streaming !== undefined && typeof value.streaming !== "boolean")) {
    throw new Error("Routing capability requirements are invalid");
  }
}
