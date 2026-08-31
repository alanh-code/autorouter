import {randomBytes} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STORE_VERSION = 1;
const DEFAULT_VALIDATION_TIMEOUT_MS = 10_000;

export const UPSTREAM_GATEWAYS = Object.freeze({
  openrouter: Object.freeze({
    baseUrl: "https://openrouter.ai/api/v1",
    credentialPath: "/key"
  }),
  "ramp-router": Object.freeze({baseUrl: "https://api.router.com/v1"})
});

export function getUpstreamCredentialPath(homeDirectory = os.homedir()) {
  return path.join(homeDirectory, ".autorouter", "upstream.json");
}

export async function configureUpstreamCredential({
  gateway,
  apiKey,
  filePath = getUpstreamCredentialPath(),
  fetchImpl = fetch,
  timeoutMs = DEFAULT_VALIDATION_TIMEOUT_MS
}) {
  const definition = getGatewayDefinition(gateway);
  const credential = normalizeApiKey(apiKey);
  const models = await validateCredential({
    definition,
    apiKey: credential,
    fetchImpl,
    timeoutMs
  });

  writeCredential(filePath, {
    version: STORE_VERSION,
    gateway,
    apiKey: credential
  });

  return {gateway, modelCount: models.length};
}

export function loadUpstreamCredential(filePath = getUpstreamCredentialPath()) {
  const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
  getGatewayDefinition(stored?.gateway);
  const apiKey = normalizeApiKey(stored?.apiKey);

  if (stored.version !== STORE_VERSION) {
    throw new Error("Stored upstream credential version is unsupported");
  }

  fs.chmodSync(filePath, 0o600);
  return {gateway: stored.gateway, apiKey};
}

async function validateCredential({definition, apiKey, fetchImpl, timeoutMs}) {
  if (definition.credentialPath) {
    await fetchJson({
      url: `${definition.baseUrl}${definition.credentialPath}`,
      apiKey,
      fetchImpl,
      timeoutMs,
      failureLabel: "credential validation"
    });
  }

  const payload = await fetchJson({
    url: `${definition.baseUrl}/models`,
    apiKey,
    fetchImpl,
    timeoutMs,
    failureLabel: "model catalog"
  });
  const models = payload?.data;

  if (!Array.isArray(models) || models.length === 0 || models.some((model) => !model?.id)) {
    throw new Error("Upstream model catalog is invalid or empty");
  }

  return models;
}

async function fetchJson({url, apiKey, fetchImpl, timeoutMs, failureLabel}) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    throw new Error(`Upstream ${failureLabel} failed with status ${response.status}`);
  }

  let payload;

  try {
    payload = await response.json();
  } catch {
    throw new Error(`Upstream ${failureLabel} returned invalid JSON`);
  }

  return payload;
}

function getGatewayDefinition(gateway) {
  const definition = UPSTREAM_GATEWAYS[gateway];

  if (!definition) {
    throw new Error(`Unsupported upstream gateway: ${gateway ?? "missing"}`);
  }

  return definition;
}

function normalizeApiKey(apiKey) {
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new Error("Upstream API key is required");
  }

  return apiKey.trim();
}

function writeCredential(filePath, credential) {
  const directoryPath = path.dirname(filePath);
  fs.mkdirSync(directoryPath, {recursive: true, mode: 0o700});
  fs.chmodSync(directoryPath, 0o700);

  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;

  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(credential)}\n`, {
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
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
}
