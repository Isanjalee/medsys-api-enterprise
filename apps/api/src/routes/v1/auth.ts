import type { FastifyPluginAsync } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { users } from "@medsys/db";
import { createUserSchema } from "@medsys/validation";
import { assertOrThrow } from "../../lib/http-error.js";
import { rotateRefreshToken, signAccessToken, validateRefreshToken } from "../../lib/auth.js";
import { writeAuditLog } from "../../lib/audit.js";
import { applyRouteDocs } from "../../lib/route-docs.js";
import { hashPassword, verifyPassword } from "../../lib/password.js";

const serializeUser = (row: {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  role: "owner" | "doctor" | "assistant";
  organizationId: string;
}) => ({
  id: row.id,
  name: `${row.firstName} ${row.lastName}`,
  email: row.email,
  role: row.role,
  organizationId: row.organizationId
});

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
    "POST /register": {
      operationId: "AuthController_register",
      summary: "Register a user or bootstrap the first owner account",
      security: [],
      bodySchema: {
        type: "object",
        additionalProperties: false,
        required: ["firstName", "lastName", "email", "password", "role"],
        properties: {
          firstName: { type: "string", minLength: 1, maxLength: 80 },
          lastName: { type: "string", minLength: 1, maxLength: 80 },
          email: { type: "string", format: "email", maxLength: 160 },
          password: { type: "string", minLength: 8, maxLength: 128 },
          role: { type: "string", enum: ["owner", "doctor", "assistant"] }
        }
      },
      bodyExample: {
        firstName: "System",
        lastName: "Owner",
        email: "owner@example.com",
        password: "owner-pass-123",
        role: "owner"
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
      const body = request.body as { email: string; password: string; organizationId: string };
      assertOrThrow(
        body?.email && body?.password && body?.organizationId,
        400,
        "Email, password and organizationId are required"
      );

      const found = await app.db
        .select({
          id: users.id,
          passwordHash: users.passwordHash,
          role: users.role,
          organizationId: users.organizationId,
          isActive: users.isActive
        })
        .from(users)
        .where(and(eq(users.email, body.email), eq(users.organizationId, body.organizationId)))
        .limit(1);

      assertOrThrow(found.length === 1, 401, "Invalid credentials");
      assertOrThrow(found[0].isActive, 403, "User is inactive");
      assertOrThrow(verifyPassword(body.password, found[0].passwordHash), 401, "Invalid credentials");

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

      return reply.send({
        accessToken,
        refreshToken,
        expiresIn: app.env.ACCESS_TOKEN_TTL_SECONDS
      });
    }
  );

  app.post("/refresh", async (request, reply) => {
    const body = request.body as { refreshToken: string };
    assertOrThrow(body?.refreshToken, 400, "refreshToken is required");

    const payload = app.jwt.verify<{ tokenId: string; sub: string; organizationId: string }>(
      body.refreshToken
    );
    assertOrThrow(payload?.tokenId, 401, "Invalid refresh token");

    const tokenState = await validateRefreshToken(app, payload.tokenId);
    assertOrThrow(tokenState, 401, "Invalid refresh token");
    const validatedTokenState = tokenState as { userId: number; organizationId: string };

    const userRows = await app.db
      .select({
        id: users.id,
        role: users.role,
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
      validatedTokenState.organizationId
    );

    return reply.send({ accessToken, refreshToken, expiresIn: app.env.ACCESS_TOKEN_TTL_SECONDS });
  });

  app.post(
    "/register",
    {
      config: {
        rateLimit: { max: 5, timeWindow: "1 minute" }
      }
    },
    async (request, reply) => {
      const payload = createUserSchema.parse(request.body);
      const userCount = await getUserCount();

      let organizationId = app.env.ORGANIZATION_ID;
      let action = "register_bootstrap";

      if (userCount === 0) {
        assertOrThrow(payload.role === "owner", 400, "First registered user must have owner role");
      } else {
        await app.authenticate(request);
        assertOrThrow(request.actor?.role === "owner", 403, "Forbidden");
        const actor = request.actor!;
        const actorRows = await app.db
          .select({ id: users.id, isActive: users.isActive })
          .from(users)
          .where(eq(users.id, actor.userId))
          .limit(1);
        assertOrThrow(actorRows.length === 1 && actorRows[0].isActive, 403, "Inactive account");
        organizationId = actor.organizationId;
        action = "register";
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
          role: payload.role
        })
        .returning({
          id: users.id,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
          role: users.role,
          organizationId: users.organizationId
        });

      await writeAuditLog(request, {
        entityType: "user",
        action,
        entityId: inserted[0].id
      });

      return reply.code(201).send({ user: serializeUser(inserted[0]) });
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
        organizationId: users.organizationId,
        isActive: users.isActive
      })
      .from(users)
      .where(and(eq(users.id, actor.userId), eq(users.organizationId, actor.organizationId)))
      .limit(1);

    assertOrThrow(rows.length === 1, 401, "User not found");
    assertOrThrow(rows[0].isActive, 403, "Inactive account");

    return serializeUser(rows[0]);
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
