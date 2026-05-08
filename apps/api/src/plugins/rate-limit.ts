import fp from "fastify-plugin";
import fastifyRateLimit from "@fastify/rate-limit";
import type { FastifyRequest } from "fastify";

const BEARER_PREFIX = "Bearer ";

const READ_HEAVY_PREFIXES = ["/v1/analytics", "/v1/reports", "/v1/inventory", "/v1/tasks", "/v1/users"] as const;

const decodeBase64Url = (value: string): string | null => {
  if (!value) {
    return null;
  }

  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const paddingLength = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + "=".repeat(paddingLength);

  try {
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return null;
  }
};

const getAuthorizationHeader = (request: FastifyRequest): string | null => {
  const raw = request.headers.authorization;
  if (typeof raw === "string") {
    return raw;
  }
  if (Array.isArray(raw)) {
    return raw[0] ?? null;
  }
  return null;
};

const resolveAuthAwareRateKey = (request: FastifyRequest): string | null => {
  const authorization = getAuthorizationHeader(request);
  if (!authorization || !authorization.startsWith(BEARER_PREFIX)) {
    return null;
  }

  const token = authorization.slice(BEARER_PREFIX.length).trim();
  const tokenParts = token.split(".");
  if (tokenParts.length !== 3) {
    return null;
  }

  const payloadJson = decodeBase64Url(tokenParts[1] ?? "");
  if (!payloadJson) {
    return null;
  }

  try {
    const parsed = JSON.parse(payloadJson) as {
      sub?: unknown;
      organizationId?: unknown;
    };
    const organizationId =
      typeof parsed.organizationId === "string" && parsed.organizationId.length > 0
        ? parsed.organizationId
        : null;
    const subject =
      typeof parsed.sub === "string" || typeof parsed.sub === "number" ? String(parsed.sub) : null;

    if (!organizationId || !subject) {
      return null;
    }

    return `${organizationId}:${subject}`;
  } catch {
    return null;
  }
};

const isReadHeavyRoute = (requestUrl: string, method: string): boolean => {
  if (method !== "GET") {
    return false;
  }

  const path = requestUrl.split("?")[0] ?? requestUrl;
  return READ_HEAVY_PREFIXES.some((prefix) => path.startsWith(prefix));
};

const rateLimitPlugin = fp(async (app) => {
  await app.register(fastifyRateLimit, {
    max: async (request, _key) => (isReadHeavyRoute(request.url, request.method) ? 240 : 100),
    timeWindow: "1 minute",
    keyGenerator: (request) => {
      const authAwareKey = resolveAuthAwareRateKey(request);
      if (authAwareKey) {
        return authAwareKey;
      }
      return request.ip;
    }
  });
});

export default rateLimitPlugin;
