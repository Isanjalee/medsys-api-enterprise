import type { FastifyPluginAsync } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { users } from "@medsys/db";
import { hasAllResolvedPermissions } from "@medsys/types";
import { authLoginSchema, createUserFrontendSchema, createUserSchema, refreshTokenSchema } from "@medsys/validation";
import { assertOrThrow, parseOrThrowValidation, validationError } from "../../lib/http-error.js";
import { revokeRefreshTokens, rotateRefreshToken, signAccessToken, validateRefreshToken } from "../../lib/auth.js";
import { serializeAuthUser, serializeCreatedUser } from "../../lib/api-serializers.js";
import { writeAuditLog } from "../../lib/audit.js";
import { applyRouteDocs } from "../../lib/route-docs.js";
import { splitFullName } from "../../lib/names.js";
import { hashPassword, verifyPassword } from "../../lib/password.js";
import {
  assertAssignableExtraPermissions,
  normalizeStoredExtraPermissions,
  resolveUserPermissions
} from "../../lib/user-permissions.js";

const hasAnyKey = (value: unknown, keys: string[]): boolean =>
  Boolean(
    value &&
      typeof value === "object" &&
      keys.some((key) => Object.prototype.hasOwnProperty.call(value, key))
  );

const toSerializedUser = (row: {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  role: "owner" | "doctor" | "assistant";
  extraPermissions: unknown;
  createdAt?: Date;
}) => {
  const extraPermissions = normalizeStoredExtraPermissions(row.extraPermissions);
  return serializeAuthUser({
    ...row,
    extraPermissions,
    permissions: resolveUserPermissions(row.role, extraPermissions)
  });
};

const buildAuthTokenPayload = (
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
  user: ReturnType<typeof toSerializedUser>
) => ({
  accessToken,
  refreshToken,
  expiresIn,
  access_token: accessToken,
  refresh_token: refreshToken,
  expires_in: expiresIn,
  tokenType: "Bearer" as const,
  token_type: "Bearer" as const,
  user
});

const toSerializedCreatedUser = (row: {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  role: "owner" | "doctor" | "assistant";
  extraPermissions: unknown;
  createdAt: Date;
}) => {
  const extraPermissions = normalizeStoredExtraPermissions(row.extraPermissions);
  return serializeCreatedUser({
    ...row,
    extraPermissions,
    permissions: resolveUserPermissions(row.role, extraPermissions)
  });
};

const getLoginThrottleKey = (request: {
  ip: string;
  body?: unknown;
}): string => {
  const body = request.body as Record<string, unknown> | undefined;
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "unknown";
  const organizationId =
    typeof body?.organizationId === "string" ? body.organizationId.trim() : "unknown";

  return `${organizationId}:${email}:${request.ip}`;
};

const authRoutes: FastifyPluginAsync = async (app) => {
  applyRouteDocs(app, "Auth", "AuthController", {
    "POST /login": {
      operationId: "AuthController_login",
      summary: "Authenticate user and issue tokens",
      security: [],
      bodySchema: {
        type: "object",
        additionalProperties: false,
        required: ["email", "password", "organizationId"],
        properties: {
          email: { type: "string", format: "email" },
          password: { type: "string", minLength: 1 },
          organizationId: { type: "string", format: "uuid" }
        }
      },
      bodyExample: {
        email: "owner@medsys.local",
        password: "ChangeMe123!",
        organizationId: "11111111-1111-1111-1111-111111111111"
      }
    },
    "POST /refresh": {
      operationId: "AuthController_refresh",
      summary: "Rotate refresh token and issue new tokens",
      security: [],
      bodySchema: {
        type: "object",
        additionalProperties: false,
        required: ["refreshToken"],
        properties: {
          refreshToken: { type: "string", minLength: 20 }
        }
      },
      bodyExample: {
        refreshToken: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9..."
      }
    },
    "POST /logout": {
      operationId: "AuthController_logout",
      summary: "Revoke active refresh tokens for the authenticated user"
    },
    "POST /register": {
      operationId: "AuthController_register",
      summary: "Register a user or bootstrap the first owner account",
      security: [],
      bodySchema: {
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
              extraPermissions: {
                type: "array",
                items: { type: "string", enum: ["patient.write", "appointment.create", "family.write", "inventory.write", "prescription.dispense"] }
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
              extraPermissions: {
                type: "array",
                items: { type: "string", enum: ["patient.write", "appointment.create", "family.write", "inventory.write", "prescription.dispense"] }
              }
            }
          }
        ]
      },
      bodyExamples: {
        frontend: {
          summary: "Frontend-compatible payload",
            value: {
              name: "System Owner",
              email: "owner@example.com",
              password: "owner-pass-123",
              role: "owner"
          }
        },
        backend: {
          summary: "Direct API payload",
            value: {
              firstName: "System",
              lastName: "Owner",
              email: "owner@example.com",
              password: "owner-pass-123",
              role: "owner"
            }
          },
          doctorWithAssistantSupport: {
            summary: "Doctor with assistant-support permissions",
            value: {
              firstName: "Support",
              lastName: "Doctor",
              email: "doctor-support@example.com",
              password: "doctor-pass-123",
              role: "doctor",
              extraPermissions: ["inventory.write"]
            }
          }
        }
    },
    "GET /me": {
      operationId: "AuthController_me",
      summary: "Get the authenticated user profile"
    },
    "GET /status": {
      operationId: "AuthController_status",
      summary: "Get authentication bootstrap status",
      security: []
    }
  });

  const getUserCount = async (): Promise<number> => {
    const result = await app.readDb
      .select({ count: sql<number>`count(*)` })
      .from(users);

    return Number(result[0]?.count ?? 0);
  };

  app.post(
    "/login",
    {
      config: {
        rateLimit: { max: 5, timeWindow: "1 minute" }
      }
    },
    async (request, reply) => {
      const body = parseOrThrowValidation(authLoginSchema, request.body);
      const lockout = await app.securityService.isLoginLocked(getLoginThrottleKey(request));
      if (lockout.locked) {
        reply.header("Retry-After", String(lockout.retryAfterSeconds));
      }
      assertOrThrow(!lockout.locked, 429, "Too many failed login attempts");

      const found = await app.db
        .select({
          id: users.id,
          passwordHash: users.passwordHash,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          role: users.role,
          extraPermissions: users.extraPermissions,
          createdAt: users.createdAt,
          organizationId: users.organizationId,
          isActive: users.isActive
        })
        .from(users)
        .where(and(eq(users.email, body.email), eq(users.organizationId, body.organizationId)))
        .limit(1);

      if (found.length !== 1 || !verifyPassword(body.password, found[0].passwordHash)) {
        await app.securityService.registerLoginFailure(getLoginThrottleKey(request));
        assertOrThrow(false, 401, "Invalid credentials");
      }

      assertOrThrow(found[0].isActive, 403, "User is inactive");
      await app.securityService.clearLoginFailures(getLoginThrottleKey(request));

      const accessToken = await signAccessToken(app, {
        sub: String(found[0].id),
        role: found[0].role,
        organizationId: found[0].organizationId
      });
      const refreshToken = await rotateRefreshToken(app, found[0].id, found[0].organizationId);

      await writeAuditLog(request, {
        entityType: "auth",
        action: "login_success",
        entityId: found[0].id
      });

      return reply.send(
        buildAuthTokenPayload(
          accessToken,
          refreshToken,
          app.env.ACCESS_TOKEN_TTL_SECONDS,
          toSerializedUser(found[0])
        )
      );
    }
  );

  app.post("/refresh", async (request, reply) => {
    const body = parseOrThrowValidation(refreshTokenSchema, request.body);

    const payload = app.jwt.verify<{ tokenId: string; sub: string; organizationId: string }>(
      body.refreshToken
    );
    assertOrThrow(payload?.tokenId, 401, "Invalid refresh token");

    const tokenState = await validateRefreshToken(app, payload.tokenId);
    assertOrThrow(tokenState, 401, "Invalid refresh token");
    const validatedTokenState = tokenState!;

    const userRows = await app.db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        role: users.role,
        extraPermissions: users.extraPermissions,
        createdAt: users.createdAt,
        isActive: users.isActive
      })
      .from(users)
      .where(eq(users.id, validatedTokenState.userId))
      .limit(1);
    assertOrThrow(userRows.length === 1 && userRows[0].isActive, 401, "User not found");

    const accessToken = await signAccessToken(app, {
        sub: String(userRows[0].id),
        role: userRows[0].role,
        organizationId: validatedTokenState.organizationId
      });
    const refreshToken = await rotateRefreshToken(
      app,
      userRows[0].id,
      validatedTokenState.organizationId,
      {
        tokenId: validatedTokenState.tokenId,
        familyId: validatedTokenState.familyId
      }
    );

    return reply.send(
      buildAuthTokenPayload(
        accessToken,
        refreshToken,
        app.env.ACCESS_TOKEN_TTL_SECONDS,
        toSerializedUser(userRows[0])
      )
    );
  });

  app.post("/logout", { preHandler: app.authenticate }, async (request) => {
    const actor = request.actor!;

    await revokeRefreshTokens(app, actor.userId, actor.organizationId);

    await writeAuditLog(request, {
      entityType: "auth",
      action: "logout",
      entityId: actor.userId
    });

    return { success: true };
  });

  app.post(
    "/register",
    {
      config: {
        rateLimit: { max: 5, timeWindow: "1 minute" }
      }
    },
    async (request, reply) => {
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
              extraPermissions: frontendPayload.extraPermissions ?? []
            };
          })()
        : parseOrThrowValidation(createUserSchema.strict(), request.body);
      const payload = {
        ...parsedPayload,
        extraPermissions: assertAssignableExtraPermissions(
          parsedPayload.role,
          parsedPayload.extraPermissions ?? []
        )
      };
      const userCount = await getUserCount();

      let organizationId = app.env.ORGANIZATION_ID;
      let action = "register_bootstrap";

      if (userCount === 0) {
        if (payload.role !== "owner") {
          throw validationError([
            {
              field: "role",
              message: "First registered user must have owner role."
            }
          ]);
        }
      } else {
        await app.authenticate(request);
        assertOrThrow(Boolean(request.actor), 401, "Unauthorized");
        assertOrThrow(hasAllResolvedPermissions(request.actor!.permissions, ["user.write"]), 403, "Forbidden");
        const actor = request.actor!;
        organizationId = actor.organizationId;
        action = "register";
      }

      if (userCount > 0) {
        const allowed = await app.securityService.consumeSensitiveAction(
          "user.write",
          request.actor!.role,
          `${organizationId}:${request.actor!.userId}`
        );
        assertOrThrow(allowed, 429, "Sensitive action rate limit exceeded");
      }

      const existing = await app.readDb
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.organizationId, organizationId), eq(users.email, payload.email)))
        .limit(1);
      assertOrThrow(existing.length === 0, 409, "User already exists");

      const inserted = await app.db
        .insert(users)
        .values({
          organizationId,
          email: payload.email,
          passwordHash: hashPassword(payload.password),
          firstName: payload.firstName,
          lastName: payload.lastName,
          role: payload.role,
          extraPermissions: payload.extraPermissions
        })
        .returning({
          id: users.id,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
          role: users.role,
          extraPermissions: users.extraPermissions,
          createdAt: users.createdAt
        });

      await writeAuditLog(request, {
        entityType: "user",
        action,
        entityId: inserted[0].id
      });

      return reply.code(201).send({ user: toSerializedCreatedUser(inserted[0]) });
    }
  );

  app.get("/me", { preHandler: app.authenticate }, async (request) => {
    const actor = request.actor!;
    const rows = await app.readDb
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        role: users.role,
        extraPermissions: users.extraPermissions,
        createdAt: users.createdAt,
        isActive: users.isActive
      })
      .from(users)
      .where(and(eq(users.id, actor.userId), eq(users.organizationId, actor.organizationId)))
      .limit(1);

    assertOrThrow(rows.length === 1, 401, "User not found");
    assertOrThrow(rows[0].isActive, 403, "Inactive account");

    return toSerializedUser(rows[0]);
  });

  app.get("/status", async () => {
    const userCount = await getUserCount();

    return {
      bootstrapping: userCount === 0,
      users: userCount
    };
  });
};

export default authRoutes;
