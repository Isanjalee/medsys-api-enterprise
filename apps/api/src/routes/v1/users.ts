import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { users } from "@medsys/db";
import {
  createUserFrontendSchema,
  createUserSchema,
  idParamSchema,
  listUsersQuerySchema,
  updateUserSchema
} from "@medsys/validation";
import { assertOrThrow, parseOrThrowValidation } from "../../lib/http-error.js";
import { serializeCreatedUser } from "../../lib/api-serializers.js";
import { splitFullName } from "../../lib/names.js";
import { hashPassword } from "../../lib/password.js";
import { writeAuditLog } from "../../lib/audit.js";
import { applyRouteDocs } from "../../lib/route-docs.js";
import {
  assertAssignableExtraPermissions,
  normalizeStoredDoctorWorkflowMode,
  normalizeStoredExtraPermissions,
  resolveDoctorWorkflowMode,
  resolveUserPermissions
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
    role: "doctor"
  }
} as const;

const updateUserBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
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
  }
} as const;

const toSerializedCreatedUser = (row: {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  role: "owner" | "doctor" | "assistant";
  doctorWorkflowMode: unknown;
  extraPermissions: unknown;
  createdAt: Date;
}) => {
  const extraPermissions = normalizeStoredExtraPermissions(row.extraPermissions);
  const doctorWorkflowMode = normalizeStoredDoctorWorkflowMode(row.doctorWorkflowMode);
  return serializeCreatedUser({
    ...row,
    doctorWorkflowMode,
    extraPermissions,
    permissions: resolveUserPermissions(row.role, extraPermissions)
  });
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
        frontend: {
          summary: "Frontend-compatible payload",
          value: {
            name: "Jane Doe",
            email: "doctor@example.com",
            password: "strong-pass-123",
            role: "doctor"
          }
        },
        backend: {
          summary: "Direct API payload",
          value: {
            firstName: "Jane",
            lastName: "Doe",
            email: "doctor@example.com",
            password: "strong-pass-123",
            role: "doctor"
          }
        },
        doctorWithAssistantSupport: {
          summary: "Doctor with assistant-support permissions",
          value: {
            firstName: "Support",
            lastName: "Doctor",
            email: "doctor-support@example.com",
            password: "strong-pass-123",
            role: "doctor",
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
        grantAssistantSupport: {
          summary: "Grant assistant-support permissions",
          value: {
            doctorWorkflowMode: "clinic_supported",
            extraPermissions: ["patient.write", "appointment.create", "prescription.dispense"]
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
      const whereClause = query.role
        ? and(eq(users.organizationId, actor.organizationId), eq(users.role, query.role))
        : eq(users.organizationId, actor.organizationId);

      const rows = await app.readDb
        .select({
          id: users.id,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
          role: users.role,
          doctorWorkflowMode: users.doctorWorkflowMode,
          extraPermissions: users.extraPermissions,
          createdAt: users.createdAt
        })
        .from(users)
        .where(whereClause)
        .orderBy(desc(users.createdAt));

      await writeAuditLog(request, { entityType: "user", action: "list" });
      return { users: rows.map(toSerializedCreatedUser) };
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
              doctorWorkflowMode: frontendPayload.doctorWorkflowMode,
              extraPermissions: frontendPayload.extraPermissions ?? []
            };
          })()
        : parseOrThrowValidation(createUserSchema.strict(), request.body);
      const payload = {
        ...parsedPayload,
        doctorWorkflowMode: resolveDoctorWorkflowMode(parsedPayload.role, parsedPayload.doctorWorkflowMode),
        extraPermissions: assertAssignableExtraPermissions(
          parsedPayload.role,
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
          doctorWorkflowMode: payload.doctorWorkflowMode,
          extraPermissions: payload.extraPermissions
        })
        .returning({
          id: users.id,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
          role: users.role,
          doctorWorkflowMode: users.doctorWorkflowMode,
          extraPermissions: users.extraPermissions,
          createdAt: users.createdAt
        });

      await writeAuditLog(request, {
        entityType: "user",
        action: "create",
        entityId: inserted[0].id
      });

      return reply.code(201).send({ user: toSerializedCreatedUser(inserted[0]) });
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
          doctorWorkflowMode: users.doctorWorkflowMode,
          isActive: users.isActive,
          extraPermissions: users.extraPermissions,
          createdAt: users.createdAt
        })
        .from(users)
        .where(and(eq(users.id, id), eq(users.organizationId, actor.organizationId)))
        .limit(1);
      assertOrThrow(existingRows.length === 1, 404, "User not found");

      const nextDoctorWorkflowMode =
        payload.doctorWorkflowMode === undefined
          ? normalizeStoredDoctorWorkflowMode(existingRows[0].doctorWorkflowMode)
          : resolveDoctorWorkflowMode(existingRows[0].role, payload.doctorWorkflowMode);

      const nextExtraPermissions =
        payload.extraPermissions === undefined
          ? normalizeStoredExtraPermissions(existingRows[0].extraPermissions)
          : assertAssignableExtraPermissions(existingRows[0].role, payload.extraPermissions ?? []);

      const patch: Record<string, unknown> = {
        updatedAt: new Date()
      };
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
          doctorWorkflowMode: users.doctorWorkflowMode,
          extraPermissions: users.extraPermissions,
          createdAt: users.createdAt
        });
      assertOrThrow(updated.length === 1, 404, "User not found");

      await writeAuditLog(request, {
        entityType: "user",
        action: "update",
        entityId: updated[0].id
      });

      return { user: toSerializedCreatedUser(updated[0]) };
    }
  );
};

export default userRoutes;
