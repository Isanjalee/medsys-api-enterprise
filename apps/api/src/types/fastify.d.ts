import "fastify";
import type { AppEnv } from "@medsys/config";
import type { buildDbClient } from "@medsys/db";
import type { UserRole } from "@medsys/types";
import type { FastifyRequest, preHandlerHookHandler } from "fastify";
import type { AuditPublisher } from "../lib/audit-publisher.js";

declare module "fastify" {
  interface FastifyInstance {
    env: AppEnv;
    db: ReturnType<typeof buildDbClient>["db"];
    readDb: ReturnType<typeof buildDbClient>["db"];
    analyticsDb: ReturnType<typeof buildDbClient>["db"];
    auditPublisher: AuditPublisher;
    authenticate: (request: FastifyRequest) => Promise<void>;
    authorize: (roles: UserRole[]) => preHandlerHookHandler;
  }

  interface FastifyRequest {
    actor?: {
      userId: number;
      role: UserRole;
      organizationId: string;
    };
  }
}
