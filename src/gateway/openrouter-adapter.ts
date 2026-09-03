import {defineUpstreamAdapter, UpstreamGatewayError} from "./upstream-adapter.js";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

type UnknownRecord = Record<string, unknown>;
type FetchImplementation = typeof fetch;
type GatewayErrorOptions = {
  kind?: string;
  statusCode?: number | null;
  providerCode?: string | number | null;
  requestId?: string | null;
  retryable?: boolean;
  cause?: unknown;
};
const TypedUpstreamGatewayError = UpstreamGatewayError as unknown as new (
  message: string,
  options?: GatewayErrorOptions
) => InstanceType<typeof UpstreamGatewayError>;

export type OpenRouterModel = Readonly<{
  id: string;
  name: string;
  provider: string;
  inputModalities: readonly string[];
  outputModalities: readonly string[];
  supportedParameters: readonly string[];
  contextTokens: number | null;
  maxOutputTokens: number | null;
  promptPricePerToken: number | null;
  completionPricePerToken: number | null;
}>;

export type NormalizedUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  cost: number | null;
}>;

export function createOpenRouterAdapter({
  fetchImpl = fetch,
  baseUrl = OPENROUTER_BASE_URL
}: {
  fetchImpl?: FetchImplementation;
  baseUrl?: string;
} = {}) {
  const adapter = {
    id: "openrouter",
    baseUrl,

    createAuthHeaders({apiKey}: {apiKey: string}): Record<string, string> {
      const credential = normalizeRequiredString(apiKey, "OpenRouter API key");

      return {
        Accept: "application/json",
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
        "X-OpenRouter-Metadata": "enabled"
      };
    },

    async listModels({
      apiKey,
      signal
    }: {
      apiKey: string;
      signal?: AbortSignal;
    }): Promise<readonly OpenRouterModel[]> {
      const response = await request(`${baseUrl}/models`, {
        method: "GET",
        headers: adapter.createAuthHeaders({apiKey}),
        signal
      });
      const payload = await readJson(response);
      const models = requireArray(payload.data, "OpenRouter model catalog");

      if (models.length === 0) {
        throw new Error("OpenRouter model catalog is empty");
      }

      const seenIds = new Set<string>();
      return Object.freeze(models.map((model) => {
        const normalized = normalizeModel(model);

        if (seenIds.has(normalized.id)) {
          throw new Error(`OpenRouter model catalog contains duplicate id: ${normalized.id}`);
        }

        seenIds.add(normalized.id);
        return normalized;
      }));
    },

    translateRequest({
      request: value,
      modelId
    }: {
      request: unknown;
      modelId: string;
    }): UnknownRecord {
      const request = requireRecord(value, "OpenRouter request must be an object");
      const exactModelId = normalizeRequiredString(modelId, "OpenRouter model id");
      const translated: UnknownRecord = {...request, model: exactModelId, stream: false};
      delete translated.models;
      delete translated.route;
      return translated;
    },

    async createResponse({
      headers,
      request: requestBody,
      signal
    }: {
      headers: HeadersInit;
      request: unknown;
      signal?: AbortSignal;
    }): Promise<UnknownRecord> {
      const translatedRequest = requireRecord(requestBody, "OpenRouter request must be an object");
      normalizeRequiredString(translatedRequest.model, "OpenRouter model id");

      const response = await request(`${baseUrl}/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify(translatedRequest),
        signal
      });
      const payload = await readJson(response);
      normalizeRequiredString(payload.id, "OpenRouter response id");
      normalizeRequiredString(payload.model, "OpenRouter response model");
      return payload;
    },

    async streamResponse(): Promise<never> {
      throw new Error("OpenRouter streaming is not implemented");
    },

    normalizeUsage(value: unknown): NormalizedUsage {
      const usage = value === null || value === undefined
        ? {}
        : requireRecord(value, "OpenRouter usage must be an object");
      const inputDetails = optionalRecord(usage.input_tokens_details ?? usage.prompt_tokens_details);
      const outputDetails = optionalRecord(usage.output_tokens_details ?? usage.completion_tokens_details);
      const inputTokens = normalizeTokenCount(usage.input_tokens ?? usage.prompt_tokens);
      const outputTokens = normalizeTokenCount(usage.output_tokens ?? usage.completion_tokens);

      return Object.freeze({
        inputTokens,
        outputTokens,
        totalTokens: normalizeTokenCount(usage.total_tokens, inputTokens + outputTokens),
        cachedInputTokens: normalizeTokenCount(inputDetails?.cached_tokens),
        reasoningTokens: normalizeTokenCount(outputDetails?.reasoning_tokens),
        cost: normalizeOptionalNumber(usage.cost, "OpenRouter usage cost")
      });
    },

    classifyError(context: unknown) {
      const details = optionalRecord(context) ?? {};
      const statusCode = normalizeOptionalStatus(details.statusCode);
      const body = optionalRecord(details.body);
      const providerError = optionalRecord(body?.error);
      const sourceError = details.error;
      const kind = classifyErrorKind(statusCode, sourceError);
      const providerMessage = typeof providerError?.message === "string"
        ? providerError.message
        : "OpenRouter request failed";

      return new TypedUpstreamGatewayError(providerMessage, {
        kind,
        statusCode,
        providerCode: normalizeOptionalCode(providerError?.code),
        requestId: normalizeOptionalString(details.requestId),
        retryable: kind === "rate_limit" || kind === "timeout" || kind === "unavailable",
        cause: sourceError instanceof Error ? sourceError : undefined
      });
    },

    extractExecutionMetadata(value: unknown) {
      const context = requireRecord(value, "OpenRouter response context must be an object");
      const response = requireRecord(context.response, "OpenRouter response is required");
      const metadata = optionalRecord(response.openrouter_metadata);
      const endpoints = optionalRecord(metadata?.endpoints);
      const available = Array.isArray(endpoints?.available) ? endpoints.available : [];
      const selected = available
        .map(optionalRecord)
        .find((endpoint) => endpoint?.selected === true);

      return Object.freeze({
        requestedModel: normalizeOptionalString(metadata?.requested),
        actualModel: normalizeOptionalString(response.model),
        actualProvider: normalizeOptionalString(selected?.provider),
        requestId: normalizeOptionalString(context.requestId) ?? normalizeOptionalString(response.id)
      });
    }
  };

  async function request(url: string, init: RequestInit): Promise<Response> {
    try {
      const response = await fetchImpl(url, init);

      if (!response.ok) {
        const body = await readOptionalJson(response);
        throw adapter.classifyError({
          statusCode: response.status,
          body,
          requestId: response.headers.get("x-request-id")
        });
      }

      return response;
    } catch (error) {
      if (error instanceof UpstreamGatewayError) {
        throw error;
      }

      throw adapter.classifyError({error});
    }
  }

  return defineUpstreamAdapter(adapter);
}

function normalizeModel(value: unknown): OpenRouterModel {
  const model = requireRecord(value, "OpenRouter model must be an object");
  const id = normalizeRequiredString(model.id, "OpenRouter model id");
  const architecture = optionalRecord(model.architecture);
  const pricing = optionalRecord(model.pricing);
  const topProvider = optionalRecord(model.top_provider);
  const provider = id.includes("/") ? id.slice(0, id.indexOf("/")) : id;

  return Object.freeze({
    id,
    name: normalizeOptionalString(model.name) ?? id,
    provider,
    inputModalities: normalizeStringArray(architecture?.input_modalities),
    outputModalities: normalizeStringArray(architecture?.output_modalities),
    supportedParameters: normalizeStringArray(model.supported_parameters),
    contextTokens: normalizeOptionalPositiveInteger(model.context_length),
    maxOutputTokens: normalizeOptionalPositiveInteger(topProvider?.max_completion_tokens),
    promptPricePerToken: normalizeOptionalNumber(pricing?.prompt, "OpenRouter prompt price"),
    completionPricePerToken: normalizeOptionalNumber(pricing?.completion, "OpenRouter completion price")
  });
}

async function readJson(response: Response): Promise<UnknownRecord> {
  let value: unknown;

  try {
    value = await response.json();
  } catch {
    throw new Error("OpenRouter returned invalid JSON");
  }

  return requireRecord(value, "OpenRouter response must be an object");
}

async function readOptionalJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function classifyErrorKind(statusCode: number | null, error: unknown): string {
  if (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name)) {
    return "timeout";
  }
  if (error instanceof TypeError) {
    return "unavailable";
  }
  if (statusCode === 401 || statusCode === 402 || statusCode === 403) {
    return "authentication";
  }
  if (statusCode === 408) {
    return "timeout";
  }
  if (statusCode === 429) {
    return "rate_limit";
  }
  if (statusCode !== null && [400, 404, 413, 422].includes(statusCode)) {
    return "invalid_request";
  }
  if (statusCode !== null && statusCode >= 500) {
    return "unavailable";
  }
  return "unknown";
}

function normalizeTokenCount(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function normalizeOptionalNumber(value: unknown, label: string): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number) || number < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return number;
}

function normalizeOptionalPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function normalizeOptionalStatus(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function normalizeOptionalCode(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return Object.freeze([]);
  }

  return Object.freeze(value.filter((item): item is string => typeof item === "string" && item.length > 0));
}

function normalizeRequiredString(value: unknown, label: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function optionalRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function requireRecord(value: unknown, message: string): UnknownRecord {
  const record = optionalRecord(value);
  if (!record) {
    throw new Error(message);
  }
  return record;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}
