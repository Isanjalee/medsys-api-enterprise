import { and, eq, gt, isNull } from "drizzle-orm";
import { refreshTokens } from "@medsys/db";
import type { FastifyInstance } from "fastify";

export type AccessTokenPayload = {
  sub: string;
  role: "owner" | "doctor" | "assistant";
  organizationId: string;
};

export type RefreshTokenState = {
  userId: number;
  organizationId: string;
  familyId: string;
  tokenId: string;
};

export const signAccessToken = async (
  app: FastifyInstance,
  payload: AccessTokenPayload
): Promise<string> =>
  app.jwt.sign(payload, {
    algorithm: "RS256",
    expiresIn: app.env.ACCESS_TOKEN_TTL_SECONDS
  });

export const rotateRefreshToken = async (
  app: FastifyInstance,
  userId: number,
  organizationId: string,
  previous?: { tokenId: string; familyId: string }
): Promise<string> => {
  if (!previous) {
    await revokeRefreshTokens(app, userId, organizationId);
  } else {
    await app.db
      .update(refreshTokens)
      .set({
        usedAt: new Date(),
        revokedAt: new Date()
      })
      .where(
        and(
          eq(refreshTokens.tokenId, previous.tokenId),
          eq(refreshTokens.organizationId, organizationId),
          eq(refreshTokens.userId, userId),
          isNull(refreshTokens.revokedAt)
        )
      );
  }

  const inserted = await app.db
    .insert(refreshTokens)
    .values({
      organizationId,
      userId,
      familyId: previous?.familyId,
      parentTokenId: previous?.tokenId ?? null,
      expiresAt: new Date(Date.now() + app.env.REFRESH_TOKEN_TTL_SECONDS * 1000)
    })
    .returning({
      tokenId: refreshTokens.tokenId
    });

  return app.jwt.sign(
    { tokenId: inserted[0].tokenId, sub: String(userId), organizationId },
    {
      algorithm: "RS256",
      expiresIn: app.env.REFRESH_TOKEN_TTL_SECONDS
    }
  );
};

export const revokeRefreshTokens = async (
  app: FastifyInstance,
  userId: number,
  organizationId: string
): Promise<void> => {
  await app.db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(refreshTokens.userId, userId),
        eq(refreshTokens.organizationId, organizationId),
        isNull(refreshTokens.revokedAt)
      )
    );
};

export const revokeRefreshTokenFamily = async (
  app: FastifyInstance,
  familyId: string,
  organizationId: string
): Promise<void> => {
  await app.db
    .update(refreshTokens)
    .set({
      revokedAt: new Date(),
      replayDetectedAt: new Date()
    })
    .where(
      and(
        eq(refreshTokens.familyId, familyId),
        eq(refreshTokens.organizationId, organizationId),
        isNull(refreshTokens.revokedAt)
      )
    );
};

export const validateRefreshToken = async (
  app: FastifyInstance,
  tokenId: string
): Promise<RefreshTokenState | null> => {
  const rows = await app.db
    .select({
      userId: refreshTokens.userId,
      organizationId: refreshTokens.organizationId,
      familyId: refreshTokens.familyId,
      tokenId: refreshTokens.tokenId,
      revokedAt: refreshTokens.revokedAt,
      usedAt: refreshTokens.usedAt,
      expiresAt: refreshTokens.expiresAt
    })
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenId, tokenId))
    .limit(1);

  if (rows.length === 0) {
    return null;
  }

  const found = rows[0];
  if (found.usedAt || found.revokedAt) {
    await revokeRefreshTokenFamily(app, found.familyId, found.organizationId);
    return null;
  }

  if (!(found.expiresAt > new Date())) {
    return null;
  }

  const activeToken = await app.db
    .select({ id: refreshTokens.id })
    .from(refreshTokens)
    .where(
      and(
        eq(refreshTokens.tokenId, tokenId),
        isNull(refreshTokens.revokedAt),
        isNull(refreshTokens.usedAt),
        gt(refreshTokens.expiresAt, new Date())
      )
    )
    .limit(1);

  if (activeToken.length === 0) {
    return null;
  }

  return {
    userId: found.userId,
    organizationId: found.organizationId,
    familyId: found.familyId,
    tokenId: found.tokenId
  };
};
