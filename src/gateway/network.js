export const DEFAULT_GATEWAY_HOST = "127.0.0.1";

export function resolveGatewayHost(value) {
  if (value === undefined) {
    return DEFAULT_GATEWAY_HOST;
  }

  const host = value.trim();

  if (host.length === 0) {
    throw new Error("AUTOROUTER_HOST must not be empty");
  }

  return host;
}
