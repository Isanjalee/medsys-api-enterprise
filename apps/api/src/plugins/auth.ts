import fp from "fastify-plugin";
import fastifyJwt from "@fastify/jwt";
import { eq } from "drizzle-orm";
import { users } from "@medsys/db";
import { hasAllPermissions, type Permission } from "@medsys/types";
import { assertOrThrow } from "../lib/http-error.js";

const authPlugin = fp(async (app) => {
  await app.register(fastifyJwt, {
    secret: {
      private: app.env.JWT_ACCESS_PRIVATE_KEY,
      public: app.env.JWT_ACCESS_PUBLIC_KEY
    },
    sign: { algorithm: "RS256" },
    verify: { algorithms: ["RS256"] }
  });

  app.decorate("authenticate", async (request: any) => {
    await request.jwtVerify();
    const sub = Number(request.user.sub);
    assertOrThrow(Number.isInteger(sub), 401, "Invalid token subject");
    const role = request.user.role;
    const organizationId = request.user.organizationId;
    request.actor = { userId: sub, role, organizationId };
  });

  app.decorate("authorize", (roles: Array<"owner" | "doctor" | "assistant">) => {
    return async (request: any) => {
      assertOrThrow(request.actor, 401, "Unauthorized");
      assertOrThrow(roles.includes(request.actor.role), 403, "Forbidden");
      const actor = await app.db
        .select({ id: users.id, isActive: users.isActive })
        .from(users)
        .where(eq(users.id, request.actor.userId))
        .limit(1);
      assertOrThrow(actor.length === 1 && actor[0].isActive, 403, "Inactive account");
    };
  });

  app.decorate("authorizePermissions", (permissions: Permission[]) => {
    return async (request: any) => {
      assertOrThrow(request.actor, 401, "Unauthorized");
      assertOrThrow(hasAllPermissions(request.actor.role, permissions), 403, "Forbidden");
      const actor = await app.db
        .select({ id: users.id, isActive: users.isActive })
        .from(users)
        .where(eq(users.id, request.actor.userId))
        .limit(1);
      assertOrThrow(actor.length === 1 && actor[0].isActive, 403, "Inactive account");
    };
  });
});

export default authPlugin;
