import fp from "fastify-plugin";
import { and, eq } from "drizzle-orm";
import fastifyJwt from "@fastify/jwt";
import { users } from "@medsys/db";
import { hasAllResolvedPermissions, type Permission } from "@medsys/types";
import { assertOrThrow } from "../lib/http-error.js";
import { normalizeStoredExtraPermissions, resolveUserPermissions } from "../lib/user-permissions.js";

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
    const organizationId = request.user.organizationId;
    assertOrThrow(Number.isInteger(sub), 401, "Invalid token subject");
    assertOrThrow(typeof organizationId === "string" && organizationId.length > 0, 401, "Invalid organization");

    const actor = await app.db
      .select({
        id: users.id,
        role: users.role,
        organizationId: users.organizationId,
        isActive: users.isActive,
        extraPermissions: users.extraPermissions
      })
      .from(users)
      .where(and(eq(users.id, sub), eq(users.organizationId, organizationId)))
      .limit(1);

    assertOrThrow(actor.length === 1, 401, "Unauthorized");
    assertOrThrow(actor[0].isActive, 403, "Inactive account");

    const extraPermissions = normalizeStoredExtraPermissions(actor[0].extraPermissions);
    request.actor = {
      userId: actor[0].id,
      role: actor[0].role,
      organizationId: actor[0].organizationId,
      permissions: resolveUserPermissions(actor[0].role, extraPermissions),
      extraPermissions
    };
  });

  app.decorate("authorize", (roles: Array<"owner" | "doctor" | "assistant">) => {
    return async (request: any) => {
      assertOrThrow(request.actor, 401, "Unauthorized");
      assertOrThrow(roles.includes(request.actor.role), 403, "Forbidden");
    };
  });

  app.decorate("authorizePermissions", (permissions: Permission[]) => {
    return async (request: any) => {
      assertOrThrow(request.actor, 401, "Unauthorized");
      assertOrThrow(hasAllResolvedPermissions(request.actor.permissions, permissions), 403, "Forbidden");
    };
  });
});

export default authPlugin;
