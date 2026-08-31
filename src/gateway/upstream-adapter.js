export const UPSTREAM_ADAPTER_METHODS = Object.freeze([
  "createAuthHeaders",
  "listModels",
  "translateRequest",
  "createResponse",
  "streamResponse",
  "normalizeUsage",
  "classifyError",
  "extractExecutionMetadata"
]);

export const UPSTREAM_ERROR_KINDS = Object.freeze([
  "authentication",
  "invalid_request",
  "rate_limit",
  "timeout",
  "unavailable",
  "unknown"
]);

/**
 * Adapter method contract:
 * createAuthHeaders({apiKey}) -> request headers
 * listModels({apiKey, signal}) -> normalized discovered models
 * translateRequest({request, modelId}) -> upstream request payload
 * createResponse({headers, request, signal}) -> buffered upstream response
 * streamResponse({headers, request, signal}) -> async iterable of upstream events
 * normalizeUsage(rawUsage) -> normalized token and cost fields
 * classifyError(errorContext) -> UpstreamGatewayError
 * extractExecutionMetadata(responseContext) -> actual model, provider, and request IDs
 */
export function defineUpstreamAdapter(adapter) {
  if (!adapter || typeof adapter !== "object" || Array.isArray(adapter)) {
    throw new Error("Upstream adapter must be an object");
  }

  const id = normalizeRequiredString(adapter.id, "Upstream adapter id");
  const baseUrl = normalizeBaseUrl(adapter.baseUrl);

  for (const method of UPSTREAM_ADAPTER_METHODS) {
    if (typeof adapter[method] !== "function") {
      throw new Error(`Upstream adapter must implement ${method}()`);
    }
  }

  const definedAdapter = {...adapter, id, baseUrl};

  for (const method of UPSTREAM_ADAPTER_METHODS) {
    definedAdapter[method] = adapter[method].bind(adapter);
  }

  return Object.freeze(definedAdapter);
}

export class UpstreamGatewayError extends Error {
  constructor(message, {
    kind = "unknown",
    statusCode = null,
    providerCode = null,
    requestId = null,
    retryable = false,
    cause
  } = {}) {
    if (!UPSTREAM_ERROR_KINDS.includes(kind)) {
      throw new Error(`Unsupported upstream error kind: ${kind}`);
    }

    super(message, cause === undefined ? undefined : {cause});
    this.name = "UpstreamGatewayError";
    this.kind = kind;
    this.statusCode = statusCode;
    this.providerCode = providerCode;
    this.requestId = requestId;
    this.retryable = retryable;
  }
}

function normalizeBaseUrl(value) {
  const baseUrl = normalizeRequiredString(value, "Upstream adapter base URL");
  let parsed;

  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("Upstream adapter base URL must be a valid URL");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Upstream adapter base URL must use HTTPS");
  }

  return baseUrl.replace(/\/+$/, "");
}

function normalizeRequiredString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }

  return value.trim();
}
