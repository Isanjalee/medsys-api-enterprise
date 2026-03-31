import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";
import { userRoles, users } from "@medsys/db";
import { normalizeRoles, type UserRole } from "@medsys/types";
import {
  createUserFrontendSchema,
  createUserSchema,
  idParamSchema,
  listUsersQuerySchema,
  updateUserSchema
} from "@medsys/validation";
import { assertOrThrow, parseOrThrowValidation, validationError } from "../../lib/http-error.js";
import { serializeCreatedUser } from "../../lib/api-serializers.js";
import { splitFullName } from "../../lib/names.js";
import { hashPassword } from "../../lib/password.js";
import { writeAuditLog } from "../../lib/audit.js";
import { applyRouteDocs } from "../../lib/route-docs.js";
import {
  assertAssignableExtraPermissions,
  normalizeStoredRoles,
  normalizeStoredDoctorWorkflowMode,
  normalizeStoredExtraPermissions,
  resolveActiveRole,
  resolveDoctorWorkflowMode,
  resolveUserPermissionsForRoles
} from "../../lib/user-permissions.js";

const hasAnyKey = (value: unknown, keys: string[]): boolean =>
  Boolean(
    value &&
      typeof value === "object" &&
      keys.some((key) => Object.prototype.hasOwnProperty.call(value, key))
  );

const createUserBodySchema = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["name", "email", "password", "role"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 120 },
        email: { type: "string", format: "email", maxLength: 160 },
        password: { type: "string", minLength: 8, maxLength: 128 },
        role: { type: "string", enum: ["owner", "doctor", "assistant"] },
        roles: { type: "array", items: { type: "string", enum: ["owner", "doctor", "assistant"] } },
        activeRole: { type: "string", enum: ["owner", "doctor", "assistant"], nullable: true },
        doctorWorkflowMode: { type: "string", enum: ["self_service", "clinic_supported"], nullable: true },
        extraPermissions: {
          type: "array",
          items: {
            type: "string",
            enum: ["patient.write", "appointment.create", "family.write", "inventory.write", "prescription.dispense"]
          }
        }
      }
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["firstName", "lastName", "email", "password", "role"],
      properties: {
        firstName: { type: "string", minLength: 1, maxLength: 80 },
        lastName: { type: "string", minLength: 1, maxLength: 80 },
        email: { type: "string", format: "email", maxLength: 160 },
        password: { type: "string", minLength: 8, maxLength: 128 },
        role: { type: "string", enum: ["owner", "doctor", "assistant"] },
        roles: { type: "array", items: { type: "string", enum: ["owner", "doctor", "assistant"] } },
        activeRole: { type: "string", enum: ["owner", "doctor", "assistant"], nullable: true },
        doctorWorkflowMode: { type: "string", enum: ["self_service", "clinic_supported"], nullable: true },
        extraPermissions: {
          type: "array",
          items: {
            type: "string",
            enum: ["patient.write", "appointment.create", "family.write", "inventory.write", "prescription.dispense"]
          }
        }
      }
    }
  ],
  example: {
    name: "Jane Doe",
    email: "doctor@example.com",
    password: "strong-pass-123",
    roles: ["doctor"],
    activeRole: "doctor",
    doctorWorkflowMode: "self_service"
  }
} as const;

const updateUserBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    roles: { type: "array", items: { type: "string", enum: ["owner", "doctor", "assistant"] }, nullable: true },
    activeRole: { type: "string", enum: ["owner", "doctor", "assistant"], nullable: true },
    doctorWorkflowMode: { type: "string", enum: ["self_service", "clinic_supported"], nullable: true },
    extraPermissions: {
      type: "array",
      items: {
        type: "string",
        enum: ["patient.write", "appointment.create", "family.write", "inventory.write", "prescription.dispense"]
      },
      nullable: true
    },
    isActive: { type: "boolean" }
  },
  example: {
    roles: ["doctor"],
    activeRole: "doctor",
    doctorWorkflowMode: "clinic_supported",
    extraPermissions: ["inventory.write"],
    isActive: true
  }
} as const;

const toSerializedCreatedUser = (row: {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  role: "owner" | "doctor" | "assistant";
  activeRole?: unknown;
  roles?: readonly UserRole[];
  doctorWorkflowMode: unknown;
  extraPermissions: unknown;
  createdAt: Date;
}) => {
  const roles = normalizeStoredRoles(row.role, row.roles ?? []);
  const activeRole = resolveActiveRole(roles, row.activeRole as UserRole | null | undefined, row.role);
  const extraPermissions = normalizeStoredExtraPermissions(row.extraPermissions);
  const doctorWorkflowMode = normalizeStoredDoctorWorkflowMode(row.doctorWorkflowMode);
  return serializeCreatedUser({
    ...row,
    roles,
    activeRole,
    doctorWorkflowMode,
    extraPermissions,
    permissions: resolveUserPermissionsForRoles(roles, extraPermissions)
  });
};

const normalizePayloadRoles = (payload: {
  role?: UserRole;
  roles?: UserRole[];
  activeRole?: UserRole | null;
}): { roles: UserRole[]; activeRole: UserRole } => {
  const roles = normalizeRoles(payload.roles ?? (payload.role ? [payload.role] : []));
  const activeRole = resolveActiveRole(roles, payload.activeRole, payload.role);
  return { roles, activeRole };
};

const loadRolesByUserIds = async (
  app: { db: { select: Function } },
  userIds: number[]
): Promise<Map<number, UserRole[]>> => {
  const roleMap = new Map<number, UserRole[]>();
  if (userIds.length === 0) {
    return roleMap;
  }

  const rows = await app.db
    .select({
      userId: userRoles.userId,
      role: userRoles.role
    })
    .from(userRoles)
    .where(inArray(userRoles.userId, userIds));

  for (const row of rows as Array<{ userId: number; role: UserRole }>) {
    const existing = roleMap.get(row.userId) ?? [];
    existing.push(row.role);
    roleMap.set(row.userId, normalizeRoles(existing));
  }

  return roleMap;
};

const userRoutes: FastifyPluginAsync = async (app) => {
  applyRouteDocs(app, "Users", "UsersController", {
    "GET /": {
      operationId: "UsersController_findAll",
      summary: "List users"
    },
    "POST /": {
      operationId: "UsersController_create",
      summary: "Create user",
      bodySchema: createUserBodySchema,
      bodyExamples: {
        doctorSelfServiceFrontend: {
          summary: "Doctor self-service payload",
          value: {
            name: "Jane Doe",
            email: "doctor@example.com",
            password: "strong-pass-123",
            roles: ["doctor"],
            activeRole: "doctor",
            doctorWorkflowMode: "self_service"
          }
        },
        doctorClinicSupportedFrontend: {
          summary: "Doctor clinic-supported payload",
          value: {
            name: "Support Doctor",
            email: "doctor-support@example.com",
            password: "strong-pass-123",
            roles: ["owner", "doctor"],
            activeRole: "doctor",
            doctorWorkflowMode: "clinic_supported",
            extraPermissions: ["appointment.create", "prescription.dispense"]
          }
        },
        doctorSelfServiceBackend: {
          summary: "Direct API self-service payload",
          value: {
            firstName: "Jane",
            lastName: "Doe",
            email: "doctor@example.com",
            password: "strong-pass-123",
            roles: ["doctor"],
            activeRole: "doctor",
            doctorWorkflowMode: "self_service"
          }
        },
        doctorClinicSupportedBackend: {
          summary: "Direct API clinic-supported payload",
          value: {
            firstName: "Support",
            lastName: "Doctor",
            email: "doctor-support@example.com",
            password: "strong-pass-123",
            roles: ["owner", "doctor"],
            activeRole: "doctor",
            doctorWorkflowMode: "clinic_supported",
            extraPermissions: ["appointment.create", "prescription.dispense"]
          }
        }
      }
    },
    "PATCH /:id": {
      operationId: "UsersController_update",
      summary: "Update user activation or extra permissions",
      bodySchema: updateUserBodySchema,
      bodyExamples: {
        setClinicSupportedMode: {
          summary: "Set clinic-supported mode",
          value: {
            roles: ["owner", "doctor"],
            activeRole: "doctor",
            doctorWorkflowMode: "clinic_supported",
            extraPermissions: ["patient.write", "appointment.create", "prescription.dispense"]
          }
        },
        setSelfServiceMode: {
          summary: "Set self-service mode",
          value: {
            roles: ["doctor"],
            activeRole: "doctor",
            doctorWorkflowMode: "self_service",
            extraPermissions: []
          }
        },
        clearExtras: {
          summary: "Remove all extra permissions",
          value: {
            extraPermissions: []
          }
        }
      }
    }
  });

  app.addHook("preHandler", app.authenticate);

  app.get(
    "/",
    {
      preHandler: app.authorizePermissions(["user.read"]),
      schema: {
        tags: ["Users"],
        operationId: "UsersController_findAll",
        summary: "List users"
      }
    },
    async (request) => {
      const actor = request.actor!;
      const query = parseOrThrowValidation(listUsersQuerySchema, request.query ?? {});
      let whereClause = eq(users.organizationId, actor.organizationId);

      if (query.role) {
        const matchingRoleRows = await app.readDb
          .select({ userId: userRoles.userId })
          .from(userRoles)
          .where(eq(userRoles.role, query.role));

        const matchingUserIds = matchingRoleRows.map((row) => row.userId);
        if (matchingUserIds.length === 0) {
          await writeAuditLog(request, { entityType: "user", action: "list" });
          return { users: [] };
        }

        whereClause = and(eq(users.organizationId, actor.organizationId), inArray(users.id, matchingUserIds))!;
      }

      const rows = await app.readDb
        .select({
          id: users.id,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
          role: users.role,
          activeRole: users.activeRole,
          doctorWorkflowMode: users.doctorWorkflowMode,
          extraPermissions: users.extraPermissions,
          createdAt: users.createdAt
        })
        .from(users)
        .where(whereClause)
        .orderBy(desc(users.createdAt));

      const roleMap = await loadRolesByUserIds(app, rows.map((row) => row.id));
      await writeAuditLog(request, { entityType: "user", action: "list" });
      return {
        users: rows.map((row) =>
          toSerializedCreatedUser({
            ...row,
            roles: roleMap.get(row.id) ?? [row.role]
          })
        )
      };
    }
  );

  app.post(
    "/",
    {
      preHandler: [app.authorizePermissions(["user.write"]), app.enforceSensitiveRateLimit("user.write")],
      schema: {
        tags: ["Users"],
        operationId: "UsersController_create",
        summary: "Create user",
        body: createUserBodySchema
      }
    },
    async (request, reply) => {
      const actor = request.actor!;
      const useFrontendPayload =
        hasAnyKey(request.body, ["name", "email", "password", "role"]) &&
        !hasAnyKey(request.body, ["firstName", "lastName"]);
      const parsedPayload = useFrontendPayload
        ? (() => {
            const frontendPayload = parseOrThrowValidation(createUserFrontendSchema, request.body);
            const nameParts = splitFullName(frontendPayload.name);
            return {
              firstName: nameParts.firstName,
              lastName: nameParts.lastName,
              email: frontendPayload.email,
              password: frontendPayload.password,
              role: frontendPayload.role,
              roles: frontendPayload.roles,
              activeRole: frontendPayload.activeRole,
              doctorWorkflowMode: frontendPayload.doctorWorkflowMode,
              extraPermissions: frontendPayload.extraPermissions ?? []
            };
          })()
        : parseOrThrowValidation(createUserSchema, request.body);
      const normalizedRoleState = normalizePayloadRoles(parsedPayload);
      const payload = {
        ...parsedPayload,
        role: normalizedRoleState.activeRole,
        roles: normalizedRoleState.roles,
        activeRole: normalizedRoleState.activeRole,
        doctorWorkflowMode: resolveDoctorWorkflowMode(normalizedRoleState.roles, parsedPayload.doctorWorkflowMode),
        extraPermissions: assertAssignableExtraPermissions(
          normalizedRoleState.roles,
          parsedPayload.extraPermissions ?? []
        )
      };

      const existing = await app.readDb
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.organizationId, actor.organizationId), eq(users.email, payload.email)))
        .limit(1);
      assertOrThrow(existing.length === 0, 409, "User already exists");

      const inserted = await app.db
        .insert(users)
        .values({
          organizationId: actor.organizationId,
          email: payload.email,
          passwordHash: hashPassword(payload.password),
          firstName: payload.firstName,
          lastName: payload.lastName,
          role: payload.role,
          activeRole: payload.activeRole,
          doctorWorkflowMode: payload.doctorWorkflowMode,
          extraPermissions: payload.extraPermissions
        })
        .returning({
          id: users.id,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
          role: users.role,
          activeRole: users.activeRole,
          doctorWorkflowMode: users.doctorWorkflowMode,
          extraPermissions: users.extraPermissions,
          createdAt: users.createdAt
        });

      if (payload.roles.length > 0) {
        await app.db.insert(userRoles).values(
          payload.roles.map((role) => ({
            userId: inserted[0].id,
            role
          }))
        );
      }

      const insertedRoleMap = await loadRolesByUserIds(app, [inserted[0].id]);

      await writeAuditLog(request, {
        entityType: "user",
        action: "create",
        entityId: inserted[0].id
      });

      return reply.code(201).send({
        user: toSerializedCreatedUser({
          ...inserted[0],
          roles: insertedRoleMap.get(inserted[0].id) ?? payload.roles
        })
      });
    }
  );

  app.patch(
    "/:id",
    {
      preHandler: [app.authorizePermissions(["user.write"]), app.enforceSensitiveRateLimit("user.write")],
      schema: {
        tags: ["Users"],
        operationId: "UsersController_update",
        summary: "Update user activation or extra permissions",
        body: updateUserBodySchema
      }
    },
    async (request) => {
      const actor = request.actor!;
      const { id } = parseOrThrowValidation(idParamSchema, request.params);
      const payload = parseOrThrowValidation(updateUserSchema, request.body);

      const existingRows = await app.readDb
        .select({
          id: users.id,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
          role: users.role,
          activeRole: users.activeRole,
          doctorWorkflowMode: users.doctorWorkflowMode,
          isActive: users.isActive,
          extraPermissions: users.extraPermissions,
          createdAt: users.createdAt
        })
        .from(users)
        .where(and(eq(users.id, id), eq(users.organizationId, actor.organizationId)))
        .limit(1);
      assertOrThrow(existingRows.length === 1, 404, "User not found");

      const existingRoleRows = await app.readDb
        .select({ role: userRoles.role })
        .from(userRoles)
        .where(eq(userRoles.userId, existingRows[0].id));

      const nextRoles =
        payload.roles === undefined || payload.roles === null
          ? normalizeStoredRoles(existingRows[0].role, existingRoleRows.map((row) => row.role))
          : normalizeRoles(payload.roles);

      if (payload.activeRole && !nextRoles.includes(payload.activeRole)) {
        throw validationError([
          {
            field: "activeRole",
            message: "activeRole must be included in roles."
          }
        ]);
      }

      const nextActiveRole = resolveActiveRole(nextRoles, payload.activeRole, existingRows[0].activeRole ?? existingRows[0].role);

      const nextDoctorWorkflowMode =
        payload.doctorWorkflowMode === undefined
          ? normalizeStoredDoctorWorkflowMode(existingRows[0].doctorWorkflowMode)
          : resolveDoctorWorkflowMode(nextRoles, payload.doctorWorkflowMode);

      const nextExtraPermissions =
        payload.extraPermissions === undefined
          ? normalizeStoredExtraPermissions(existingRows[0].extraPermissions)
          : assertAssignableExtraPermissions(nextRoles, payload.extraPermissions ?? []);

      const patch: Record<string, unknown> = {
        updatedAt: new Date()
      };
      if (payload.roles !== undefined || payload.activeRole !== undefined) {
        patch.role = nextActiveRole;
        patch.activeRole = nextActiveRole;
      }
      if (payload.doctorWorkflowMode !== undefined) {
        patch.doctorWorkflowMode = nextDoctorWorkflowMode;
      }
      if (payload.extraPermissions !== undefined) {
        patch.extraPermissions = nextExtraPermissions;
      }
      if (payload.isActive !== undefined) {
        patch.isActive = payload.isActive;
      }

      const updated = await app.db
        .update(users)
        .set(patch)
        .where(and(eq(users.id, id), eq(users.organizationId, actor.organizationId)))
        .returning({
          id: users.id,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
          role: users.role,
          activeRole: users.activeRole,
          doctorWorkflowMode: users.doctorWorkflowMode,
          extraPermissions: users.extraPermissions,
          createdAt: users.createdAt
        });
      assertOrThrow(updated.length === 1, 404, "User not found");

      if (payload.roles !== undefined && payload.roles !== null) {
        await app.db.delete(userRoles).where(eq(userRoles.userId, id));
        if (nextRoles.length > 0) {
          await app.db.insert(userRoles).values(
            nextRoles.map((role) => ({
              userId: id,
              role
            }))
          );
        }
      }

      const updatedRoleMap = await loadRolesByUserIds(app, [updated[0].id]);

      await writeAuditLog(request, {
        entityType: "user",
        action: "update",
        entityId: updated[0].id
      });

      return {
        user: toSerializedCreatedUser({
          ...updated[0],
          roles: updatedRoleMap.get(updated[0].id) ?? nextRoles
        })
      };
    }
  );
};

export default userRoutes;
