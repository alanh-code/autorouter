import {createHash, randomBytes, timingSafeEqual} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOCAL_API_KEY_PREFIX = "ar_local_";
const LOCAL_API_KEY_BYTES = 32;

export function getLocalApiKeyPath(homeDirectory = os.homedir()) {
  return path.join(homeDirectory, ".autorouter", "local-api-key");
}

export function generateLocalApiKey(randomBytesImpl = randomBytes) {
  return `${LOCAL_API_KEY_PREFIX}${randomBytesImpl(LOCAL_API_KEY_BYTES).toString("base64url")}`;
}

export function loadOrCreateLocalApiKey({
  filePath = getLocalApiKeyPath(),
  generateKey = generateLocalApiKey
} = {}) {
  try {
    return readLocalApiKey(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  ensurePrivateDirectory(path.dirname(filePath));
  const key = generateKey();

  try {
    const descriptor = fs.openSync(filePath, "wx", 0o600);

    try {
      fs.writeFileSync(descriptor, `${key}\n`);
    } finally {
      fs.closeSync(descriptor);
    }

    return key;
  } catch (error) {
    if (error.code === "EEXIST") {
      return readLocalApiKey(filePath);
    }

    throw error;
  }
}

export function rotateLocalApiKey({
  filePath = getLocalApiKeyPath(),
  generateKey = generateLocalApiKey
} = {}) {
  ensurePrivateDirectory(path.dirname(filePath));
  const key = generateKey();
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;

  try {
    fs.writeFileSync(temporaryPath, `${key}\n`, {encoding: "utf8", flag: "wx", mode: 0o600});
    fs.renameSync(temporaryPath, filePath);
    fs.chmodSync(filePath, 0o600);
    return key;
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

export function getBearerToken(authorizationHeader) {
  if (typeof authorizationHeader !== "string") {
    return null;
  }

  const match = authorizationHeader.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] ?? null;
}

export function matchesLocalApiKey(candidate, expected) {
  if (typeof candidate !== "string" || typeof expected !== "string") {
    return false;
  }

  const candidateHash = createHash("sha256").update(candidate).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(candidateHash, expectedHash);
}

function readLocalApiKey(filePath) {
  const key = fs.readFileSync(filePath, "utf8").trim();

  if (!key.startsWith(LOCAL_API_KEY_PREFIX) || key.length <= LOCAL_API_KEY_PREFIX.length) {
    throw new Error("Stored local API key is invalid");
  }

  fs.chmodSync(filePath, 0o600);
  return key;
}

function ensurePrivateDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, {recursive: true, mode: 0o700});
  fs.chmodSync(directoryPath, 0o700);
}
