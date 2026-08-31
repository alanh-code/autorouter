import http from "node:http";
import {getBearerToken, matchesLocalApiKey} from "./auth.js";
import {
  createCompletedResponse,
  createModelList,
  createResponseEvents,
  formatServerSentEvent
} from "./protocol.js";

const DEFAULT_MAX_BODY_BYTES = 1_000_000;

export function createGatewayServer({
  localApiKey,
  models = [],
  handleResponse = unavailableResponseHandler,
  createId,
  now = Date.now,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES
} = {}) {
  if (typeof localApiKey !== "string" || localApiKey.length === 0) {
    throw new Error("A local API key is required");
  }

  return http.createServer((request, response) => {
    handleGatewayRequest({
      request,
      response,
      localApiKey,
      models,
      handleResponse,
      createId,
      now,
      maxBodyBytes
    }).catch((error) => writeError(response, error));
  });
}

async function handleGatewayRequest({request, response, localApiKey, models, handleResponse, createId, now, maxBodyBytes}) {
  const bearerToken = getBearerToken(request.headers.authorization);

  if (!matchesLocalApiKey(bearerToken, localApiKey)) {
    response.setHeader("WWW-Authenticate", 'Bearer realm="autorouter"');
    return writeError(
      response,
      new GatewayHttpError(401, "invalid_api_key", "Invalid API key", null, "authentication_error")
    );
  }

  const url = new URL(request.url ?? "/", "http://localhost");

  if (url.pathname === "/v1/models") {
    if (request.method !== "GET") {
      return writeMethodNotAllowed(response, "GET");
    }

    return writeJson(response, 200, createModelList(models, toUnixTimestamp(now())));
  }

  if (url.pathname === "/v1/responses") {
    if (request.method !== "POST") {
      return writeMethodNotAllowed(response, "POST");
    }

    return handleCreateResponse({request, response, handleResponse, createId, now, maxBodyBytes});
  }

  return writeError(response, new GatewayHttpError(404, "not_found", "Route not found"));
}

async function handleCreateResponse({request, response, handleResponse, createId, now, maxBodyBytes}) {
  const body = await readJsonBody(request, maxBodyBytes);
  validateResponseRequest(body);
  const createdAt = toUnixTimestamp(now());
  const result = await handleResponse(body, {signal: createRequestSignal(request, response)});

  if (!result || typeof result.outputText !== "string") {
    throw new GatewayHttpError(500, "server_error", "Response handler returned invalid output");
  }

  const completedAt = toUnixTimestamp(now());
  const completedResponse = createCompletedResponse({
    request: body,
    result,
    createdAt,
    completedAt,
    createId
  });

  if (body.stream === true) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });

    for (const event of createResponseEvents(completedResponse)) {
      response.write(formatServerSentEvent(event));
    }

    response.end();
    return;
  }

  writeJson(response, 200, completedResponse);
}

async function readJsonBody(request, maxBodyBytes) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    totalBytes += chunk.length;

    if (totalBytes > maxBodyBytes) {
      throw new GatewayHttpError(413, "request_too_large", "Request body is too large");
    }

    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    throw new GatewayHttpError(400, "invalid_request_error", "Request body must be JSON");
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new GatewayHttpError(400, "invalid_request_error", "Request body must be valid JSON");
  }
}

function validateResponseRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new GatewayHttpError(400, "invalid_request_error", "Request body must be a JSON object");
  }

  if (typeof body.model !== "string" || !body.model.trim()) {
    throw new GatewayHttpError(400, "invalid_request_error", "model is required", "model");
  }

  if (!("input" in body)) {
    throw new GatewayHttpError(400, "invalid_request_error", "input is required", "input");
  }
}

function createRequestSignal(request, response) {
  const controller = new AbortController();
  request.once("aborted", () => controller.abort());
  response.once("close", () => {
    if (!response.writableEnded) {
      controller.abort();
    }
  });
  return controller.signal;
}

function writeJson(response, statusCode, body) {
  response.writeHead(statusCode, {"Content-Type": "application/json; charset=utf-8"});
  response.end(`${JSON.stringify(body)}\n`);
}

function writeMethodNotAllowed(response, allowedMethod) {
  response.setHeader("Allow", allowedMethod);
  writeError(response, new GatewayHttpError(405, "method_not_allowed", "Method not allowed"));
}

function writeError(response, error) {
  if (response.writableEnded) {
    return;
  }

  const statusCode = error instanceof GatewayHttpError ? error.statusCode : 500;
  const code = error instanceof GatewayHttpError ? error.code : "server_error";
  const type = error instanceof GatewayHttpError ? error.type : "server_error";
  const message = error instanceof GatewayHttpError ? error.message : "Internal server error";
  const param = error instanceof GatewayHttpError ? error.param : null;

  if (response.headersSent) {
    response.end();
    return;
  }

  writeJson(response, statusCode, {
    error: {
      message,
      type,
      param,
      code
    }
  });
}

function toUnixTimestamp(milliseconds) {
  return Math.floor(milliseconds / 1000);
}

async function unavailableResponseHandler() {
  throw new GatewayHttpError(503, "gateway_not_ready", "No response handler is configured");
}

class GatewayHttpError extends Error {
  constructor(statusCode, code, message, param = null, type = code) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.type = type;
    this.param = param;
  }
}
