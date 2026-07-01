import fp from "fastify-plugin";
import { and, eq } from "drizzle-orm";
import fastifyJwt from "@fastify/jwt";
import { patientAccounts, platformAdmins, userRoles, users } from "@medsys/db";
import { hasAllResolvedPermissions, resolveWorkflowProfiles, type Permission } from "@medsys/types";
import { assertOrThrow } from "../lib/http-error.js";
import {
  normalizeStoredRoles,
  normalizeStoredDoctorWorkflowMode,
  normalizeStoredExtraPermissions,
  resolveActiveRole,
  resolveUserPermissionsForRoles
} from "../lib/user-permissions.js";

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
        activeRole: users.activeRole,
        doctorWorkflowMode: users.doctorWorkflowMode,
        organizationId: users.organizationId,
        isActive: users.isActive,
        extraPermissions: users.extraPermissions
      })
      .from(users)
      .where(and(eq(users.id, sub), eq(users.organizationId, organizationId)))
      .limit(1);

    assertOrThrow(actor.length === 1, 401, "Unauthorized");
    assertOrThrow(actor[0].isActive, 403, "Inactive account");

    const storedRoles = await app.db
      .select({ role: userRoles.role })
      .from(userRoles)
      .where(eq(userRoles.userId, actor[0].id));

    const roles = normalizeStoredRoles(actor[0].role, storedRoles.map((row) => row.role));
    const activeRole = resolveActiveRole(roles, actor[0].activeRole, actor[0].role);
    const extraPermissions = normalizeStoredExtraPermissions(actor[0].extraPermissions);
    const doctorWorkflowMode = normalizeStoredDoctorWorkflowMode(actor[0].doctorWorkflowMode);
    request.actor = {
      userId: actor[0].id,
      role: activeRole,
      roles,
      activeRole,
      organizationId: actor[0].organizationId,
      permissions: resolveUserPermissionsForRoles(roles, extraPermissions),
      workflowProfiles: resolveWorkflowProfiles(roles, doctorWorkflowMode),
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

  app.decorate("authenticatePatient", async (request: any) => {
    await request.jwtVerify();
    assertOrThrow(request.user?.scope === "patient", 403, "Patient access required");
    const patientAccountId = Number(request.user.sub);
    assertOrThrow(Number.isInteger(patientAccountId), 401, "Invalid token subject");

    const rows = await app.db
      .select({
        id: patientAccounts.id,
        email: patientAccounts.email,
        profileCompleted: patientAccounts.profileCompleted,
        isActive: patientAccounts.isActive
      })
      .from(patientAccounts)
      .where(eq(patientAccounts.id, patientAccountId))
      .limit(1);

    assertOrThrow(rows.length === 1, 401, "Unauthorized");
    assertOrThrow(rows[0].isActive, 403, "Inactive account");

    request.patientActor = {
      patientAccountId: rows[0].id,
      email: rows[0].email,
      profileCompleted: rows[0].profileCompleted
    };
  });

  app.decorate("authenticatePlatformAdmin", async (request: any) => {
    await request.jwtVerify();
    assertOrThrow(request.user?.scope === "platform_admin", 403, "Platform admin access required");
    const adminId = Number(request.user.sub);
    assertOrThrow(Number.isInteger(adminId), 401, "Invalid token subject");

    const rows = await app.db
      .select({
        id: platformAdmins.id,
        username: platformAdmins.username,
        displayName: platformAdmins.displayName,
        isActive: platformAdmins.isActive
      })
      .from(platformAdmins)
      .where(eq(platformAdmins.id, adminId))
      .limit(1);

    assertOrThrow(rows.length === 1, 401, "Unauthorized");
    assertOrThrow(rows[0].isActive, 403, "Inactive platform admin");

    request.platformAdmin = {
      id: rows[0].id,
      username: rows[0].username,
      displayName: rows[0].displayName
    };
  });
});

export default authPlugin;
