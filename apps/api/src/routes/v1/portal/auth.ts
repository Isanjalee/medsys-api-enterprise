import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import { patientAccounts } from "@medsys/db";
import { portalLoginSchema, portalSignupSchema, refreshTokenSchema } from "@medsys/validation";
import { assertOrThrow, parseOrThrowValidation } from "../../../lib/http-error.js";
import { hashPassword, verifyPassword } from "../../../lib/password.js";
import {
  revokePatientRefreshTokens,
  rotatePatientRefreshToken,
  signPatientAccessToken,
  validatePatientRefreshToken
} from "../../../lib/patient-auth.js";

type AccountRow = typeof patientAccounts.$inferSelect;

const serializeAccount = (a: AccountRow) => ({
  id: a.id,
  email: a.email,
  phone: a.phone ?? null,
  firstName: a.firstName ?? null,
  lastName: a.lastName ?? null,
  dob: a.dob ?? null,
  gender: a.gender ?? null,
  nic: a.nic ?? null,
  address: a.address ?? null,
  bloodGroup: a.bloodGroup ?? null,
  allergies: a.allergies ?? [],
  profileCompleted: a.profileCompleted
});

const portalAuthRoutes: FastifyPluginAsync = async (app) => {
  const issueTokens = async (account: AccountRow, previous?: { tokenId: string; familyId: string }) => ({
    accessToken: await signPatientAccessToken(app, account.id),
    refreshToken: await rotatePatientRefreshToken(app, account.id, previous),
    expiresIn: app.env.ACCESS_TOKEN_TTL_SECONDS,
    account: serializeAccount(account)
  });

  app.post("/signup", async (request, reply) => {
    const body = parseOrThrowValidation(portalSignupSchema, request.body);
    const existing = await app.db
      .select({ id: patientAccounts.id })
      .from(patientAccounts)
      .where(eq(patientAccounts.email, body.email))
      .limit(1);
    assertOrThrow(existing.length === 0, 409, "An account with this email already exists");

    const inserted = await app.db
      .insert(patientAccounts)
      .values({
        email: body.email,
        passwordHash: hashPassword(body.password),
        phone: body.phone ?? null
      })
      .returning();
    return reply.code(201).send(await issueTokens(inserted[0]));
  });

  app.post("/login", async (request) => {
    const body = parseOrThrowValidation(portalLoginSchema, request.body);
    const found = await app.db
      .select()
      .from(patientAccounts)
      .where(eq(patientAccounts.email, body.email))
      .limit(1);
    if (found.length !== 1 || !verifyPassword(body.password, found[0].passwordHash)) {
      assertOrThrow(false, 401, "Invalid credentials");
    }
    assertOrThrow(found[0].isActive, 403, "Inactive account");
    return issueTokens(found[0]);
  });

  app.post("/refresh", async (request) => {
    const body = parseOrThrowValidation(refreshTokenSchema, request.body);
    let payload: { tokenId?: string; scope?: string } | null = null;
    try {
      payload = app.jwt.verify(body.refreshToken) as { tokenId?: string; scope?: string };
    } catch {
      assertOrThrow(false, 401, "Invalid refresh token");
    }
    assertOrThrow(payload?.scope === "patient" && typeof payload?.tokenId === "string", 401, "Invalid refresh token");

    const state = await validatePatientRefreshToken(app, payload!.tokenId!);
    assertOrThrow(state, 401, "Invalid refresh token");

    const account = await app.db
      .select()
      .from(patientAccounts)
      .where(eq(patientAccounts.id, state!.patientAccountId))
      .limit(1);
    assertOrThrow(account.length === 1 && account[0].isActive, 401, "Unauthorized");

    return issueTokens(account[0], { tokenId: state!.tokenId, familyId: state!.familyId });
  });

  app.post("/logout", { preHandler: app.authenticatePatient }, async (request) => {
    await revokePatientRefreshTokens(app, request.patientActor!.patientAccountId);
    return { ok: true };
  });

  app.get("/me", { preHandler: app.authenticatePatient }, async (request) => {
    const rows = await app.db
      .select()
      .from(patientAccounts)
      .where(eq(patientAccounts.id, request.patientActor!.patientAccountId))
      .limit(1);
    assertOrThrow(rows.length === 1, 404, "Account not found");
    return serializeAccount(rows[0]);
  });
};

export default portalAuthRoutes;
