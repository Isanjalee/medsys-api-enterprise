// Token issuance/rotation for patient-portal accounts. Mirrors lib/auth.ts but for
// the GLOBAL patient identity: tokens carry { scope: "patient" } and no organization.
import { randomUUID } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { patientRefreshTokens } from "@medsys/db";
import type { FastifyInstance } from "fastify";

export type PatientAccessTokenPayload = {
  sub: string;
  scope: "patient";
};

export type PatientRefreshTokenState = {
  patientAccountId: number;
  familyId: string;
  tokenId: string;
};

export const signPatientAccessToken = async (
  app: FastifyInstance,
  patientAccountId: number
): Promise<string> =>
  app.jwt.sign(
    { sub: String(patientAccountId), scope: "patient" },
    { algorithm: "RS256", expiresIn: app.env.ACCESS_TOKEN_TTL_SECONDS }
  );

export const rotatePatientRefreshToken = async (
  app: FastifyInstance,
  patientAccountId: number,
  previous?: { tokenId: string; familyId: string }
): Promise<string> => {
  const familyId = previous?.familyId ?? randomUUID();

  if (!previous) {
    await revokePatientRefreshTokens(app, patientAccountId);
  } else {
    await app.db
      .update(patientRefreshTokens)
      .set({ usedAt: new Date(), revokedAt: new Date() })
      .where(
        and(
          eq(patientRefreshTokens.tokenId, previous.tokenId),
          eq(patientRefreshTokens.patientAccountId, patientAccountId),
          isNull(patientRefreshTokens.revokedAt)
        )
      );
  }

  const inserted = await app.db
    .insert(patientRefreshTokens)
    .values({
      patientAccountId,
      familyId,
      parentTokenId: previous?.tokenId ?? null,
      expiresAt: new Date(Date.now() + app.env.REFRESH_TOKEN_TTL_SECONDS * 1000)
    })
    .returning({ tokenId: patientRefreshTokens.tokenId });

  return app.jwt.sign(
    { tokenId: inserted[0].tokenId, sub: String(patientAccountId), scope: "patient" },
    { algorithm: "RS256", expiresIn: app.env.REFRESH_TOKEN_TTL_SECONDS }
  );
};

export const revokePatientRefreshTokens = async (
  app: FastifyInstance,
  patientAccountId: number
): Promise<void> => {
  await app.db
    .update(patientRefreshTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(patientRefreshTokens.patientAccountId, patientAccountId),
        isNull(patientRefreshTokens.revokedAt)
      )
    );
};

export const revokePatientRefreshTokenFamily = async (
  app: FastifyInstance,
  familyId: string
): Promise<void> => {
  await app.db
    .update(patientRefreshTokens)
    .set({ revokedAt: new Date(), replayDetectedAt: new Date() })
    .where(
      and(eq(patientRefreshTokens.familyId, familyId), isNull(patientRefreshTokens.revokedAt))
    );
};

export const validatePatientRefreshToken = async (
  app: FastifyInstance,
  tokenId: string
): Promise<PatientRefreshTokenState | null> => {
  const rows = await app.db
    .select({
      patientAccountId: patientRefreshTokens.patientAccountId,
      familyId: patientRefreshTokens.familyId,
      tokenId: patientRefreshTokens.tokenId,
      revokedAt: patientRefreshTokens.revokedAt,
      usedAt: patientRefreshTokens.usedAt,
      expiresAt: patientRefreshTokens.expiresAt
    })
    .from(patientRefreshTokens)
    .where(eq(patientRefreshTokens.tokenId, tokenId))
    .limit(1);

  if (rows.length === 0) {
    return null;
  }

  const found = rows[0];
  if (found.usedAt || found.revokedAt) {
    await revokePatientRefreshTokenFamily(app, found.familyId);
    return null;
  }
  if (!(found.expiresAt > new Date())) {
    return null;
  }

  const activeToken = await app.db
    .select({ id: patientRefreshTokens.id })
    .from(patientRefreshTokens)
    .where(
      and(
        eq(patientRefreshTokens.tokenId, tokenId),
        isNull(patientRefreshTokens.revokedAt),
        isNull(patientRefreshTokens.usedAt),
        gt(patientRefreshTokens.expiresAt, new Date())
      )
    )
    .limit(1);

  if (activeToken.length === 0) {
    return null;
  }

  return {
    patientAccountId: found.patientAccountId,
    familyId: found.familyId,
    tokenId: found.tokenId
  };
};
