import type {Server} from "node:http";
import {createCanonicalInventory} from "../core/canonical-inventory.ts";
import {loadBenchmarkSnapshot, syncBenchmarkSnapshot, getBenchmarkCachePath} from "../core/benchmark-data.ts";
import type {BenchmarkSnapshot} from "../core/benchmark-data.ts";
import {classifyRequest} from "../core/request-classifier.ts";
import {selectModelDeterministically} from "../core/request-routing-policy.ts";
import {createOpenRouterAdapter} from "./openrouter-adapter.ts";
import type {OpenRouterModel} from "./openrouter-adapter.ts";
import {createGatewayServer, GatewayHttpError} from "./server.js";
import {UpstreamGatewayError} from "./upstream-adapter.js";

type Adapter = ReturnType<typeof createOpenRouterAdapter>;
type Request = Record<string, unknown>;

export async function createRoutedGateway({
  localApiKey, credential, adapter = createOpenRouterAdapter(), cachePath = getBenchmarkCachePath()
}: {
  localApiKey: string;
  credential: {gateway: string; apiKey: string};
  adapter?: Adapter;
  cachePath?: string;
}): Promise<Server> {
  if (credential.gateway !== "openrouter") {
    throw new Error("Request execution currently requires the OpenRouter upstream");
  }
  const catalog = await adapter.listModels({apiKey: credential.apiKey, signal: AbortSignal.timeout(30_000)});
  let benchmarks: BenchmarkSnapshot;
  try {
    benchmarks = loadBenchmarkSnapshot(cachePath);
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
    benchmarks = await syncBenchmarkSnapshot({
      adapter: {listModels: async () => catalog}, apiKey: credential.apiKey, filePath: cachePath
    });
  }
  const handleResponse = createRoutedResponseHandler({catalog, benchmarks, adapter, apiKey: credential.apiKey});
  // The existing JavaScript server's default handler has no declared parameters.
  const createServer = createGatewayServer as unknown as (options: {
    localApiKey: string; models: {id: string; provider: string}[]; handleResponse: typeof handleResponse;
  }) => Server;
  return createServer({localApiKey, models: [{id: "autorouter", provider: "autorouter"}], handleResponse});
}

export function createRoutedResponseHandler({catalog, benchmarks, adapter, apiKey}: {
  catalog: readonly OpenRouterModel[];
  benchmarks: BenchmarkSnapshot;
  adapter: Adapter;
  apiKey: string;
}) {
  const inventory = createCanonicalInventory(catalog.filter((model) =>
    model.provider !== "openrouter" && model.id.includes("/")
    && model.contextTokens !== null && model.maxOutputTokens !== null
    && model.maxOutputTokens <= model.contextTokens
    && model.inputModalities.length > 0 && model.outputModalities.includes("text")
  ).map((model) => ({
    id: model.id.replace("/", ":"), label: model.name,
    capabilities: {
      inputModalities: model.inputModalities, outputModalities: model.outputModalities,
      toolCalls: model.supportedParameters.includes("tools"), streaming: true
    },
    pricing: model.promptPricePerToken === null || model.completionPricePerToken === null ? null : {
      inputPerMillion: model.promptPricePerToken * 1_000_000,
      outputPerMillion: model.completionPricePerToken * 1_000_000
    },
    limits: {contextTokens: model.contextTokens, maxOutputTokens: model.maxOutputTokens},
    upstreams: {openrouter: {modelId: model.id, available: true}}
  })));

  return async (request: Request, context: {signal?: AbortSignal} = {}) => {
    validateRequest(request);
    const maxOutputTokens = request.max_output_tokens as number | undefined ?? 1024;
    // UTF-8 bytes are a conservative text budget, not a measured tokenizer count.
    const estimatedInputTokens = Buffer.byteLength(JSON.stringify({input: request.input, instructions: request.instructions}), "utf8");
    const signal = AbortSignal.any([AbortSignal.timeout(120_000), ...(context.signal ? [context.signal] : [])]);
    try {
      const classification = await classifyRequest({adapter, apiKey, request, signal});
      if (classification.requiredCapabilities.toolCalls
        || classification.requiredCapabilities.inputModalities.some((value) => value !== "text")
        || classification.requiredCapabilities.outputModalities.some((value) => value !== "text")) {
        reject("This request requires capabilities beyond text execution");
      }
      const decision = selectModelDeterministically({inventory, benchmarks, requirements: {
        classification,
        upstream: "openrouter", estimatedInputTokens, estimatedOutputTokens: maxOutputTokens,
        streaming: request.stream === true
      }});
      const translated = adapter.translateRequest({
        request: {...request, max_output_tokens: maxOutputTokens}, modelId: decision.upstreamModelId
      });
      if (request.stream === true) {
        const stream = await adapter.streamResponse({headers: adapter.createAuthHeaders({apiKey}), request: translated, signal});
        return {stream, classification, decision,
          tokenEstimate: {method: "utf8_bytes", input: estimatedInputTokens, outputBudget: maxOutputTokens}};
      }
      const response = await adapter.createResponse({headers: adapter.createAuthHeaders({apiKey}), request: translated, signal});
      if (response.object !== "response" || !Array.isArray(response.output)
        || !["completed", "incomplete"].includes(String(response.status))) {
        throw new GatewayHttpError(502, "upstream_response_invalid", "Upstream returned an unsupported response");
      }
      return {
        response, classification, decision,
        usage: adapter.normalizeUsage(response.usage),
        execution: adapter.extractExecutionMetadata({response}),
        tokenEstimate: {method: "utf8_bytes", input: estimatedInputTokens, outputBudget: maxOutputTokens}
      };
    } catch (error) {
      if (error instanceof UpstreamGatewayError) {
        const status = error.kind === "rate_limit" ? 429 : error.kind === "timeout" ? 504 : 502;
        throw new GatewayHttpError(status, "upstream_error", "Upstream request failed");
      }
      throw error;
    }
  };
}

function validateRequest(request: Request): void {
  if (request.model !== "autorouter") reject("Use the autorouter model");
  if (request.stream !== undefined && typeof request.stream !== "boolean") reject("stream must be a boolean");
  if (request.tools !== undefined && (!Array.isArray(request.tools) || request.tools.length > 0)) reject("Tool calls are not supported yet");
  if (request.previous_response_id != null) reject("Send complete message history; previous_response_id is not supported yet");
  if (request.instructions !== undefined && typeof request.instructions !== "string") reject("instructions must be text");
  if (request.max_output_tokens !== undefined && (!Number.isSafeInteger(request.max_output_tokens)
    || Number(request.max_output_tokens) <= 0)) reject("max_output_tokens must be a positive integer");
  if (typeof request.input === "string") return;
  if (!Array.isArray(request.input) || !request.input.length) reject("input must contain text messages");
  for (const item of request.input as unknown[]) {
    if (!item || typeof item !== "object") reject("input must contain text messages");
    const message = item as Request;
    if (!['user', 'assistant', 'system', 'developer'].includes(String(message.role))
      || (message.type !== undefined && message.type !== "message")) reject("Unsupported input message");
    if (typeof message.content === "string") continue;
    if (!Array.isArray(message.content) || message.content.some((part) => !part
      || !["input_text", "output_text"].includes(part.type) || typeof part.text !== "string")) reject("Only text content is supported");
  }
}

function reject(message: string): never {
  throw new GatewayHttpError(400, "invalid_request_error", message);
}
