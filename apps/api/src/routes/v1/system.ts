import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { sql } from "drizzle-orm";
import { applyRouteDocs } from "../../lib/route-docs.js";

type DependencyStatus = "up" | "degraded" | "down";

type DependencyCheck = {
  status: DependencyStatus;
  configured: boolean;
  mode?: string;
  latencyMs?: number;
  message?: string;
};

const healthStatusFromDependencies = (checks: DependencyCheck[]): DependencyStatus => {
  if (checks.some((check) => check.status === "down")) {
    return "down";
  }
  if (checks.some((check) => check.status === "degraded")) {
    return "degraded";
  }
  return "up";
};

const checkDatabaseHealth = async (app: FastifyInstance): Promise<DependencyCheck> => {
  const startedAt = Date.now();

  try {
    await app.readDb.execute(sql`select 1 as ok`);
    return {
      status: "up",
      configured: true,
      latencyMs: Date.now() - startedAt
    };
  } catch (error) {
    app.log.warn({ err: error }, "Database health check failed");
    return {
      status: "down",
      configured: true,
      latencyMs: Date.now() - startedAt,
      message: "Database connectivity check failed."
    };
  }
};

const checkCacheHealth = async (app: FastifyInstance): Promise<DependencyCheck> => {
  const redisConfigured = Boolean(app.env.REDIS_URL);
  const cacheMode = app.cacheService.mode;

  if (!redisConfigured) {
    return {
      status: "up",
      configured: false,
      mode: cacheMode,
      message: "Redis is not configured."
    };
  }

  if (cacheMode !== "redis") {
    return {
      status: "degraded",
      configured: true,
      mode: cacheMode,
      message: "Redis is configured but the API is using memory cache fallback."
    };
  }

  const startedAt = Date.now();
  try {
    await app.cacheService.getStats();
    return {
      status: "up",
      configured: true,
      mode: cacheMode,
      latencyMs: Date.now() - startedAt
    };
  } catch (error) {
    app.log.warn({ err: error }, "Cache health check failed");
    return {
      status: "down",
      configured: true,
      mode: cacheMode,
      latencyMs: Date.now() - startedAt,
      message: "Redis cache check failed."
    };
  }
};

const checkSearchHealth = async (app: FastifyInstance): Promise<DependencyCheck> => {
  const opensearchUrl = app.env.OPENSEARCH_URL;
  const openSearchConfigured = Boolean(opensearchUrl);
  const searchMode = app.searchService.mode;

  if (!openSearchConfigured) {
    return {
      status: "up",
      configured: false,
      mode: searchMode,
      message: "OpenSearch is not configured."
    };
  }

  if (searchMode !== "opensearch") {
    return {
      status: "degraded",
      configured: true,
      mode: searchMode,
      message: "OpenSearch is configured but the API is using database fallback search."
    };
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const baseUrl = opensearchUrl!.replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/_cluster/health?filter_path=status`, {
      method: "GET",
      signal: controller.signal
    });

    if (!response.ok) {
      return {
        status: "down",
        configured: true,
        mode: searchMode,
        latencyMs: Date.now() - startedAt,
        message: `OpenSearch health check returned ${response.status}.`
      };
    }

    return {
      status: "up",
      configured: true,
      mode: searchMode,
      latencyMs: Date.now() - startedAt
    };
  } catch (error) {
    app.log.warn({ err: error }, "Search health check failed");
    return {
      status: "down",
      configured: true,
      mode: searchMode,
      latencyMs: Date.now() - startedAt,
      message: "OpenSearch connectivity check failed."
    };
  } finally {
    clearTimeout(timeout);
  }
};

const systemRoutes: FastifyPluginAsync = async (app) => {
  applyRouteDocs(app, "System", "SystemController", {
    "GET /health": {
      operationId: "SystemController_health",
      summary: "Get service health status for dashboard checks"
    },
    "GET /system/health": {
      operationId: "SystemController_systemHealth",
      summary: "Get service and dependency health status"
    }
  });

  const handler = async (_request: FastifyRequest, reply: FastifyReply) => {
    const [database, cache, search] = await Promise.all([
      checkDatabaseHealth(app),
      checkCacheHealth(app),
      checkSearchHealth(app)
    ]);

    const status = healthStatusFromDependencies([database, cache, search]);
    const statusCode = status === "down" ? 503 : 200;

    return reply.code(statusCode).send({
      status,
      service: "medsys-api",
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      dependencies: {
        database,
        cache,
        search
      }
    });
  };

  app.get("/health", handler);
  app.get("/system/health", handler);
};

export default systemRoutes;
