import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { and, eq } from "drizzle-orm";
import { users } from "@medsys/db";
import { assertOrThrow } from "../../lib/http-error.js";
import { rotateRefreshToken, signAccessToken, validateRefreshToken } from "../../lib/auth.js";
import { writeAuditLog } from "../../lib/audit.js";
import { applyRouteDocs } from "../../lib/route-docs.js";

const hashPassword = (password: string): string => createHash("sha256").update(password).digest("hex");

const verifyPassword = (password: string, storedHash: string): boolean => {
  const parsedHash = storedHash.startsWith("sha256:") ? storedHash.slice("sha256:".length) : storedHash;
  const incoming = Buffer.from(hashPassword(password));
  const stored = Buffer.from(parsedHash);
  if (incoming.length !== stored.length) {
    return false;
  }
  return timingSafeEqual(incoming, stored);
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
    }
  });

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
};

export default authRoutes;
