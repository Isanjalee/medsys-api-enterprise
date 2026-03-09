import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { users } from "@medsys/db";
import { createUserFrontendSchema, createUserSchema, listUsersQuerySchema } from "@medsys/validation";
import { assertOrThrow, parseOrThrowValidation } from "../../lib/http-error.js";
import { buildDisplayName, splitFullName } from "../../lib/names.js";
import { hashPassword } from "../../lib/password.js";
import { writeAuditLog } from "../../lib/audit.js";
import { applyRouteDocs } from "../../lib/route-docs.js";

const serializeUser = (row: {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  role: "owner" | "doctor" | "assistant";
  createdAt: Date;
}) => ({
  id: row.id,
  name: buildDisplayName(row.firstName, row.lastName),
  email: row.email,
  role: row.role,
  created_at: row.createdAt
});

const hasAnyKey = (value: unknown, keys: string[]): boolean =>
  Boolean(
    value &&
      typeof value === "object" &&
      keys.some((key) => Object.prototype.hasOwnProperty.call(value, key))
  );

const userRoutes: FastifyPluginAsync = async (app) => {
  applyRouteDocs(app, "Users", "UsersController", {
    "GET /": {
      operationId: "UsersController_findAll",
      summary: "List users"
    },
    "POST /": {
      operationId: "UsersController_create",
      summary: "Create user",
      bodySchema: {
        type: "object",
        additionalProperties: false,
        required: ["name", "email", "password", "role"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 120 },
          email: { type: "string", format: "email", maxLength: 160 },
          password: { type: "string", minLength: 8, maxLength: 128 },
          role: { type: "string", enum: ["owner", "doctor", "assistant"] }
        }
      },
      bodyExample: {
        name: "Jane Doe",
        email: "doctor@example.com",
        password: "strong-pass-123",
        role: "doctor"
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
          createdAt: users.createdAt
        })
        .from(users)
        .where(whereClause)
        .orderBy(desc(users.createdAt));

      await writeAuditLog(request, { entityType: "user", action: "list" });
      return { users: rows.map(serializeUser) };
    }
  );

  app.post(
    "/",
    {
      preHandler: app.authorizePermissions(["user.write"]),
      schema: {
        tags: ["Users"],
        operationId: "UsersController_create",
        summary: "Create user"
      }
    },
    async (request, reply) => {
      const actor = request.actor!;
      const useFrontendPayload =
        hasAnyKey(request.body, ["name", "email", "password", "role"]) &&
        !hasAnyKey(request.body, ["firstName", "lastName"]);
      const payload = useFrontendPayload
        ? (() => {
            const frontendPayload = parseOrThrowValidation(createUserFrontendSchema, request.body);
            const nameParts = splitFullName(frontendPayload.name);
            return {
              firstName: nameParts.firstName,
              lastName: nameParts.lastName,
              email: frontendPayload.email,
              password: frontendPayload.password,
              role: frontendPayload.role
            };
          })()
        : parseOrThrowValidation(createUserSchema.strict(), request.body);

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
          role: payload.role
        })
        .returning({
          id: users.id,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
          role: users.role,
          createdAt: users.createdAt
        });

      await writeAuditLog(request, {
        entityType: "user",
        action: "create",
        entityId: inserted[0].id
      });

      return reply.code(201).send({ user: serializeUser(inserted[0]) });
    }
  );
};

export default userRoutes;
