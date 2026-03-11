import "fastify";
import type { AppEnv } from "@medsys/config";
import type { buildDbClient } from "@medsys/db";
import type { Permission, UserRole } from "@medsys/types";
import type { FastifyRequest, preHandlerHookHandler } from "fastify";
import type { AuditPublisher } from "../lib/audit-publisher.js";
import type { CacheService } from "../lib/cache-service.js";
import type { ObservabilityService } from "../lib/observability-service.js";
import type { SearchService } from "../lib/search-service.js";
import type { SecurityService } from "../lib/security-service.js";

declare module "fastify" {
  interface FastifyInstance {
    env: AppEnv;
    db: ReturnType<typeof buildDbClient>["db"];
    readDb: ReturnType<typeof buildDbClient>["db"];
    analyticsDb: ReturnType<typeof buildDbClient>["db"];
    auditPublisher: AuditPublisher;
    cacheService: CacheService;
    observability: ObservabilityService;
    searchService: SearchService;
    securityService: SecurityService;
    authenticate: (request: FastifyRequest) => Promise<void>;
    authorize: (roles: UserRole[]) => preHandlerHookHandler;
    authorizePermissions: (permissions: Permission[]) => preHandlerHookHandler;
    enforceSensitiveRateLimit: (
      action: "prescription.dispense" | "inventory.write" | "user.write"
    ) => preHandlerHookHandler;
  }

  interface FastifyRequest {
    actor?: {
      userId: number;
      role: UserRole;
      organizationId: string;
    };
    traceId?: string;
  }
}
