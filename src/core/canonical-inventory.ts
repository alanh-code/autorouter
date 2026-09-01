import {parseModelId} from "./model-id.js";

const PRICING_FIELDS = [
  "inputPerMillion",
  "outputPerMillion",
  "inputCacheHitPerMillion",
  "inputCacheMissPerMillion"
] as const;
const CAPABILITY_FIELDS = ["inputModalities", "outputModalities", "toolCalls", "streaming"] as const;
const LIMIT_FIELDS = ["contextTokens", "maxOutputTokens"] as const;
const UPSTREAM_FIELDS = ["modelId", "available"] as const;

type UnknownRecord = Record<string, unknown>;

export type CanonicalUpstream = Readonly<{
  modelId: string | null;
  available: boolean;
}>;

export type CanonicalModel = Readonly<{
  id: string;
  label: string;
  provider: string;
  model: string;
  capabilities: Readonly<{
    inputModalities: readonly string[];
    outputModalities: readonly string[];
    toolCalls: boolean;
    streaming: boolean;
  }>;
  pricing: Readonly<Partial<Record<(typeof PRICING_FIELDS)[number], number>>> | null;
  limits: Readonly<{
    contextTokens: number;
    maxOutputTokens: number;
  }>;
  upstreams: Readonly<Record<string, CanonicalUpstream>>;
  supportedUpstreams: readonly string[];
  available: boolean;
}>;

export function createCanonicalInventory(models: unknown): readonly CanonicalModel[] {
  if (!Array.isArray(models)) {
    throw new Error("Canonical model inventory must be an array");
  }

  const seenIds = new Set<string>();
  const inventory = models.map((model) => {
    const normalized = normalizeCanonicalModel(model);

    if (seenIds.has(normalized.id)) {
      throw new Error(`Duplicate canonical model id: ${normalized.id}`);
    }

    seenIds.add(normalized.id);
    return normalized;
  });

  return deepFreeze(inventory);
}

export function listAvailableCanonicalModels(
  inventory: readonly CanonicalModel[],
  gateway: string | null = null
): readonly CanonicalModel[] {
  return inventory.filter((model) => {
    if (gateway === null) {
      return model.available;
    }

    const upstream = model.upstreams[gateway];
    return Boolean(upstream?.available && upstream.modelId);
  });
}

function normalizeCanonicalModel(value: unknown): CanonicalModel {
  const model = requireRecord(value, "Canonical model must be an object");
  const id = normalizeRequiredString(model.id, "Canonical model id");
  const parsed = parseModelId(id) as {provider: string; model: string};

  if (!parsed.provider || !parsed.model || /\s/.test(id)) {
    throw new Error(`Invalid canonical model id: ${id}`);
  }

  const provider = model.provider === undefined
    ? parsed.provider
    : normalizeRequiredString(model.provider, `Provider for ${id}`);

  if (provider !== parsed.provider) {
    throw new Error(`Canonical model provider does not match id: ${id}`);
  }

  const upstreams = normalizeUpstreams(model.upstreams, id);
  const supportedUpstreams = Object.keys(upstreams);
  const available = Object.values(upstreams).some(
    (upstream) => upstream.available && upstream.modelId !== null
  );

  return {
    id,
    label: normalizeRequiredString(model.label, `Label for ${id}`),
    provider,
    model: parsed.model,
    capabilities: normalizeCapabilities(model.capabilities, id),
    pricing: normalizePricing(model.pricing, id),
    limits: normalizeLimits(model.limits, id),
    upstreams,
    supportedUpstreams,
    available
  };
}

function normalizeCapabilities(value: unknown, id: string): CanonicalModel["capabilities"] {
  const capabilities = requireRecord(value, `Capabilities are required for ${id}`);
  assertKnownFields(capabilities, CAPABILITY_FIELDS, `capability for ${id}`);

  return {
    inputModalities: normalizeStringList(capabilities.inputModalities, `Input modalities for ${id}`),
    outputModalities: normalizeStringList(capabilities.outputModalities, `Output modalities for ${id}`),
    toolCalls: normalizeBoolean(capabilities.toolCalls, `Tool-call capability for ${id}`),
    streaming: normalizeBoolean(capabilities.streaming, `Streaming capability for ${id}`)
  };
}

function normalizePricing(value: unknown, id: string): CanonicalModel["pricing"] {
  if (value === null) {
    return null;
  }

  const pricing = requireRecord(value, `Pricing must be an object or null for ${id}`);
  assertKnownFields(pricing, PRICING_FIELDS, `pricing for ${id}`);
  const normalized: Partial<Record<(typeof PRICING_FIELDS)[number], number>> = {};

  for (const field of PRICING_FIELDS) {
    const price = pricing[field];
    if (price === undefined) {
      continue;
    }

    if (typeof price !== "number" || !Number.isFinite(price) || price < 0) {
      throw new Error(`Invalid ${field} pricing for ${id}`);
    }

    normalized[field] = price;
  }

  if (Object.keys(normalized).length === 0) {
    throw new Error(`Pricing has no supported fields for ${id}`);
  }

  return normalized;
}

function normalizeLimits(value: unknown, id: string): CanonicalModel["limits"] {
  const limits = requireRecord(value, `Limits are required for ${id}`);
  assertKnownFields(limits, LIMIT_FIELDS, `limit for ${id}`);
  const contextTokens = normalizePositiveInteger(limits.contextTokens, `Context limit for ${id}`);
  const maxOutputTokens = normalizePositiveInteger(limits.maxOutputTokens, `Output limit for ${id}`);

  if (maxOutputTokens > contextTokens) {
    throw new Error(`Output limit exceeds context limit for ${id}`);
  }

  return {contextTokens, maxOutputTokens};
}

function normalizeUpstreams(value: unknown, id: string): Record<string, CanonicalUpstream> {
  const upstreams = requireRecord(value, `Upstreams are required for ${id}`);
  const entries = Object.entries(upstreams);

  if (entries.length === 0) {
    throw new Error(`At least one upstream is required for ${id}`);
  }

  const normalized: Record<string, CanonicalUpstream> = {};

  for (const [gateway, value] of entries) {
    const gatewayId = normalizeRequiredString(gateway, `Upstream id for ${id}`);

    if (/\s/.test(gatewayId)) {
      throw new Error(`Invalid upstream id for ${id}: ${gatewayId}`);
    }

    if (Object.hasOwn(normalized, gatewayId)) {
      throw new Error(`Duplicate upstream id for ${id}: ${gatewayId}`);
    }

    const upstream = requireRecord(value, `Invalid ${gatewayId} upstream for ${id}`);
    assertKnownFields(upstream, UPSTREAM_FIELDS, `${gatewayId} upstream for ${id}`);
    const modelId = upstream.modelId === null
      ? null
      : normalizeRequiredString(upstream.modelId, `${gatewayId} model id for ${id}`);
    const available = normalizeBoolean(upstream.available, `${gatewayId} availability for ${id}`);

    if (available && modelId === null) {
      throw new Error(`Available upstream ${gatewayId} is missing a model id for ${id}`);
    }

    normalized[gatewayId] = {modelId, available};
  }

  return normalized;
}

function normalizeStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }

  return [...new Set(value.map((item) => normalizeRequiredString(item, label)))];
}

function normalizeBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }

  return value;
}

function normalizePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }

  return value;
}

function normalizeRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }

  return value.trim();
}

function assertKnownFields(
  value: UnknownRecord,
  allowedFields: readonly string[],
  label: string
): void {
  const unknownField = Object.keys(value).find((field) => !allowedFields.includes(field));

  if (unknownField) {
    throw new Error(`Unsupported ${label} field: ${unknownField}`);
  }
}

function requireRecord(value: unknown, message: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }

  return value as UnknownRecord;
}

function deepFreeze<T>(value: T): Readonly<T> {
  Object.freeze(value);

  for (const nested of Object.values(value as UnknownRecord)) {
    if (nested && typeof nested === "object" && !Object.isFrozen(nested)) {
      deepFreeze(nested);
    }
  }

  return value;
}
