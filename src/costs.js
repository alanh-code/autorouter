export function formatUsageCost(usage, model) {
  if (!usage) {
    return "";
  }

  const pricing = model?.pricing;

  if (!pricing) {
    return "cost unavailable";
  }

  const input = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const output = usage.completion_tokens ?? usage.output_tokens ?? 0;
  const cacheHitInput = usage.prompt_cache_hit_tokens ?? usage.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens;
  const cacheMissInput = usage.prompt_cache_miss_tokens;
  const inputCost = typeof cacheHitInput === "number" || typeof cacheMissInput === "number"
    ? ((cacheHitInput ?? 0) / 1_000_000) * (pricing.inputCacheHitPerMillion ?? pricing.inputPerMillion ?? 0) +
      ((cacheMissInput ?? Math.max(0, input - (cacheHitInput ?? 0))) / 1_000_000) * (pricing.inputCacheMissPerMillion ?? pricing.inputPerMillion ?? 0)
    : (input / 1_000_000) * (pricing.inputCacheMissPerMillion ?? pricing.inputPerMillion ?? 0);
  const outputCost = (output / 1_000_000) * (pricing.outputPerMillion ?? 0);
  const totalCost = inputCost + outputCost;

  return `${formatDollarCost(totalCost)}`;
}

export function formatDollarCost(cost) {
  if (!Number.isFinite(cost)) {
    return "cost unavailable";
  }

  if (cost === 0) {
    return "$0.000000";
  }

  return `$${cost.toFixed(6)}`;
}

export function parseDollarText(text) {
  if (typeof text !== "string" || !text.startsWith("$")) {
    return Number.NaN;
  }

  const value = Number.parseFloat(text.slice(1));
  return Number.isFinite(value) ? value : Number.NaN;
}
