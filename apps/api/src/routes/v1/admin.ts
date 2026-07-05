import type { FastifyPluginAsync } from "fastify";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { banners, organizations, platformAdmins, userRoles, users } from "@medsys/db";
import { bannerCreateSchema, bannerUpdateSchema } from "@medsys/validation";
import { assertOrThrow, parseOrThrowValidation } from "../../lib/http-error.js";
import { hashPassword, verifyPassword } from "../../lib/password.js";
import { writeAuditLog } from "../../lib/audit.js";
import { splitFullName } from "../../lib/names.js";
import { getDocument, putDocument, resolveDocumentContentType } from "../../lib/s3.js";

const loginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) }).strict();

const createOrganizationSchema = z
  .object({
    organizationName: z.string().min(2).max(160),
    organizationSlug: z
      .string()
      .min(3)
      .max(80)
      .regex(/^[a-z0-9-]+$/, "Slug may only contain lowercase letters, numbers, and hyphens."),
    ownerName: z.string().min(2).max(160),
    ownerEmail: z.string().email().max(160),
    ownerPassword: z.string().min(8).max(128),
    operatingMode: z.enum(["standard", "step_up"]).optional()
  })
  .strict();

const updateOrganizationSchema = z
  .object({
    name: z.string().min(2).max(160).optional(),
    isActive: z.boolean().optional(),
    operatingMode: z.enum(["standard", "step_up"]).optional()
  })
  .strict()
  .refine(
    (v) => v.name !== undefined || v.isActive !== undefined || v.operatingMode !== undefined,
    "At least one field must be provided."
  );

const createOrgUserSchema = z
  .object({
    name: z.string().min(2).max(160),
    email: z.string().email().max(160),
    password: z.string().min(8).max(128),
    role: z.enum(["owner", "doctor", "assistant"]),
    doctorWorkflowMode: z.enum(["self_service", "clinic_supported"]).optional()
  })
  .strict();

const updateUserSchema = z
  .object({
    email: z.string().email().max(160).optional(),
    password: z.string().min(8).max(128).optional(),
    isActive: z.boolean().optional(),
    doctorWorkflowMode: z.enum(["self_service", "clinic_supported"]).optional()
  })
  .strict()
  .refine(
    (v) =>
      v.email !== undefined ||
      v.password !== undefined ||
      v.isActive !== undefined ||
      v.doctorWorkflowMode !== undefined,
    "At least one field must be provided."
  );

const orgIdParamSchema = z.object({ id: z.string().uuid() }).strict();
const userIdParamSchema = z.object({ id: z.coerce.number().int().positive() }).strict();

const serializeOrgUser = (row: {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  isActive: boolean;
  doctorWorkflowMode: string | null;
  createdAt: Date;
}) => ({
  id: row.id,
  name: `${row.firstName} ${row.lastName}`.trim(),
  email: row.email,
  role: row.role,
  is_active: row.isActive,
  doctor_workflow_mode: row.doctorWorkflowMode,
  created_at: row.createdAt
});

const adminRoutes: FastifyPluginAsync = async (app) => {
  // --- Auth -------------------------------------------------------------------
  app.post(
    "/login",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request) => {
      const payload = parseOrThrowValidation(loginSchema, request.body);
      const rows = await app.readDb
        .select({
          id: platformAdmins.id,
          username: platformAdmins.username,
          displayName: platformAdmins.displayName,
          passwordHash: platformAdmins.passwordHash,
          isActive: platformAdmins.isActive
        })
        .from(platformAdmins)
        .where(eq(platformAdmins.username, payload.username.trim()))
        .limit(1);

      assertOrThrow(rows.length === 1, 401, "Invalid username or password.");
      assertOrThrow(rows[0].isActive, 403, "This super admin account is disabled.");
      assertOrThrow(verifyPassword(payload.password, rows[0].passwordHash), 401, "Invalid username or password.");

      const accessToken = await app.jwt.sign(
        { sub: String(rows[0].id), scope: "platform_admin", username: rows[0].username },
        { algorithm: "RS256", expiresIn: app.env.ACCESS_TOKEN_TTL_SECONDS }
      );

      return {
        accessToken,
        access_token: accessToken,
        expiresIn: app.env.ACCESS_TOKEN_TTL_SECONDS,
        admin: { id: rows[0].id, username: rows[0].username, display_name: rows[0].displayName }
      };
    }
  );

  app.get("/me", { preHandler: app.authenticatePlatformAdmin }, async (request) => {
    const admin = request.platformAdmin!;
    return { admin: { id: admin.id, username: admin.username, display_name: admin.displayName } };
  });

  // --- Organizations (medical centers) ---------------------------------------
  app.get("/organizations", { preHandler: app.authenticatePlatformAdmin }, async () => {
    const orgRows = await app.readDb
      .select({
        id: organizations.id,
        slug: organizations.slug,
        name: organizations.name,
        isActive: organizations.isActive,
        operatingMode: organizations.operatingMode,
        createdAt: organizations.createdAt
      })
      .from(organizations)
      .orderBy(desc(organizations.createdAt));

    const countRows = await app.readDb
      .select({
        organizationId: users.organizationId,
        role: users.role,
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${users.isActive})::int`
      })
      .from(users)
      .groupBy(users.organizationId, users.role);

    const countMap = new Map<string, { owners: number; doctors: number; assistants: number }>();
    for (const row of countRows) {
      const entry = countMap.get(row.organizationId) ?? { owners: 0, doctors: 0, assistants: 0 };
      if (row.role === "owner") entry.owners += row.total;
      else if (row.role === "doctor") entry.doctors += row.total;
      else if (row.role === "assistant") entry.assistants += row.total;
      countMap.set(row.organizationId, entry);
    }

    return {
      organizations: orgRows.map((org) => ({
        id: org.id,
        slug: org.slug,
        name: org.name,
        is_active: org.isActive,
        operating_mode: org.operatingMode ?? "standard",
        created_at: org.createdAt,
        counts: countMap.get(org.id) ?? { owners: 0, doctors: 0, assistants: 0 }
      }))
    };
  });

  app.post("/organizations", { preHandler: app.authenticatePlatformAdmin }, async (request) => {
    const payload = parseOrThrowValidation(createOrganizationSchema, request.body);
    const nameParts = splitFullName(payload.ownerName);
    assertOrThrow(Boolean(nameParts.firstName), 400, "Owner name is required.");

    const existing = await app.readDb
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, payload.organizationSlug))
      .limit(1);
    assertOrThrow(existing.length === 0, 409, "Organization slug already exists.");

    const result = await app.db.transaction(async (tx) => {
      const insertedOrgs = await tx
        .insert(organizations)
        .values({
          slug: payload.organizationSlug,
          name: payload.organizationName,
          operatingMode: payload.operatingMode ?? "standard"
        })
        .returning({
          id: organizations.id,
          slug: organizations.slug,
          name: organizations.name,
          isActive: organizations.isActive,
          operatingMode: organizations.operatingMode,
          createdAt: organizations.createdAt
        });
      const organization = insertedOrgs[0]!;

      const insertedUsers = await tx
        .insert(users)
        .values({
          organizationId: organization.id,
          email: payload.ownerEmail,
          passwordHash: hashPassword(payload.ownerPassword),
          firstName: nameParts.firstName,
          lastName: nameParts.lastName,
          role: "owner",
          activeRole: "owner",
          extraPermissions: []
        })
        .returning({ id: users.id });

      await tx.insert(userRoles).values({ userId: insertedUsers[0]!.id, role: "owner" });
      return { organization, ownerId: insertedUsers[0]!.id };
    });

    await writeAuditLog(request, {
      entityType: "organization",
      action: "admin_create",
      payload: { organizationId: result.organization.id, slug: result.organization.slug, by: request.platformAdmin!.username }
    });

    return {
      organization: {
        id: result.organization.id,
        slug: result.organization.slug,
        name: result.organization.name,
        is_active: result.organization.isActive,
        operating_mode: result.organization.operatingMode ?? "standard",
        created_at: result.organization.createdAt,
        counts: { owners: 1, doctors: 0, assistants: 0 }
      }
    };
  });

  app.patch("/organizations/:id", { preHandler: app.authenticatePlatformAdmin }, async (request) => {
    const { id } = parseOrThrowValidation(orgIdParamSchema, request.params);
    const payload = parseOrThrowValidation(updateOrganizationSchema, request.body);

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (payload.name !== undefined) patch.name = payload.name;
    if (payload.isActive !== undefined) patch.isActive = payload.isActive;
    if (payload.operatingMode !== undefined) patch.operatingMode = payload.operatingMode;

    const updated = await app.db
      .update(organizations)
      .set(patch)
      .where(eq(organizations.id, id))
      .returning({
        id: organizations.id,
        slug: organizations.slug,
        name: organizations.name,
        isActive: organizations.isActive,
        operatingMode: organizations.operatingMode,
        createdAt: organizations.createdAt
      });
    assertOrThrow(updated.length === 1, 404, "Organization not found.");

    await writeAuditLog(request, {
      entityType: "organization",
      action: "admin_update",
      payload: { organizationId: id, by: request.platformAdmin!.username }
    });

    return {
      organization: {
        id: updated[0].id,
        slug: updated[0].slug,
        name: updated[0].name,
        is_active: updated[0].isActive,
        operating_mode: updated[0].operatingMode ?? "standard",
        created_at: updated[0].createdAt
      }
    };
  });

  // --- Users within an organization ------------------------------------------
  app.get("/organizations/:id/users", { preHandler: app.authenticatePlatformAdmin }, async (request) => {
    const { id } = parseOrThrowValidation(orgIdParamSchema, request.params);
    const orgRows = await app.readDb
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, id))
      .limit(1);
    assertOrThrow(orgRows.length === 1, 404, "Organization not found.");

    const rows = await app.readDb
      .select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        role: users.role,
        isActive: users.isActive,
        doctorWorkflowMode: users.doctorWorkflowMode,
        createdAt: users.createdAt
      })
      .from(users)
      .where(eq(users.organizationId, id))
      .orderBy(desc(users.createdAt));

    return { users: rows.map(serializeOrgUser) };
  });

  app.post("/organizations/:id/users", { preHandler: app.authenticatePlatformAdmin }, async (request) => {
    const { id } = parseOrThrowValidation(orgIdParamSchema, request.params);
    const payload = parseOrThrowValidation(createOrgUserSchema, request.body);
    const nameParts = splitFullName(payload.name);
    assertOrThrow(Boolean(nameParts.firstName), 400, "Name is required.");

    const orgRows = await app.readDb
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, id))
      .limit(1);
    assertOrThrow(orgRows.length === 1, 404, "Organization not found.");

    const emailConflict = await app.readDb
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.organizationId, id), eq(users.email, payload.email.trim())))
      .limit(1);
    assertOrThrow(emailConflict.length === 0, 409, "A user with that email already exists in this organization.");

    const created = await app.db.transaction(async (tx) => {
      const insertedUsers = await tx
        .insert(users)
        .values({
          organizationId: id,
          email: payload.email.trim(),
          passwordHash: hashPassword(payload.password),
          firstName: nameParts.firstName,
          lastName: nameParts.lastName,
          role: payload.role,
          activeRole: payload.role,
          doctorWorkflowMode:
            payload.role === "doctor" ? payload.doctorWorkflowMode ?? "self_service" : null,
          extraPermissions: []
        })
        .returning({
          id: users.id,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
          role: users.role,
          isActive: users.isActive,
          doctorWorkflowMode: users.doctorWorkflowMode,
          createdAt: users.createdAt
        });
      await tx.insert(userRoles).values({ userId: insertedUsers[0]!.id, role: payload.role });
      return insertedUsers[0]!;
    });

    await writeAuditLog(request, {
      entityType: "user",
      action: "admin_create",
      entityId: created.id,
      payload: { organizationId: id, role: payload.role, by: request.platformAdmin!.username }
    });

    return { user: serializeOrgUser(created) };
  });

  app.patch("/users/:id", { preHandler: app.authenticatePlatformAdmin }, async (request) => {
    const { id } = parseOrThrowValidation(userIdParamSchema, request.params);
    const payload = parseOrThrowValidation(updateUserSchema, request.body);

    const existing = await app.readDb
      .select({ id: users.id, organizationId: users.organizationId, role: users.role })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    assertOrThrow(existing.length === 1, 404, "User not found.");

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (payload.email !== undefined) {
      const normalizedEmail = payload.email.trim();
      const conflict = await app.readDb
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.organizationId, existing[0].organizationId), eq(users.email, normalizedEmail)))
        .limit(1);
      assertOrThrow(
        conflict.length === 0 || conflict[0].id === id,
        409,
        "Another user in this organization already uses that email."
      );
      patch.email = normalizedEmail;
    }
    if (payload.password !== undefined) patch.passwordHash = hashPassword(payload.password);
    if (payload.isActive !== undefined) patch.isActive = payload.isActive;
    if (payload.doctorWorkflowMode !== undefined && existing[0].role === "doctor") {
      patch.doctorWorkflowMode = payload.doctorWorkflowMode;
    }

    const updated = await app.db
      .update(users)
      .set(patch)
      .where(eq(users.id, id))
      .returning({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        role: users.role,
        isActive: users.isActive,
        doctorWorkflowMode: users.doctorWorkflowMode,
        createdAt: users.createdAt
      });
    assertOrThrow(updated.length === 1, 404, "User not found.");

    await writeAuditLog(request, {
      entityType: "user",
      action: "admin_update",
      entityId: id,
      payload: { by: request.platformAdmin!.username }
    });

    return { user: serializeOrgUser(updated[0]) };
  });

  // --- Home banners (patient portal carousel) ---
  app.get("/banners", { preHandler: app.authenticatePlatformAdmin }, async () => {
    const rows = await app.db.select().from(banners).orderBy(asc(banners.sortOrder), asc(banners.id));
    return rows.map((b) => ({
      id: b.id,
      title: b.title,
      targetUrl: b.targetUrl,
      sortOrder: b.sortOrder,
      isActive: b.isActive,
      imageUrl: `/api/admin/banners/${b.id}/image`,
      createdAt: b.createdAt
    }));
  });

  app.post("/banners", { preHandler: app.authenticatePlatformAdmin }, async (request, reply) => {
    const query = parseOrThrowValidation(bannerCreateSchema, request.query);
    const file = await (request as unknown as { file: () => Promise<{ filename?: string; mimetype?: string; toBuffer: () => Promise<Buffer> } | undefined> }).file();
    assertOrThrow(file, 400, "No image uploaded");
    const fileName = String(file!.filename ?? "banner").slice(0, 255);
    const contentType = resolveDocumentContentType(file!.mimetype, fileName);
    assertOrThrow(contentType && contentType.startsWith("image/"), 415, "Only image files are allowed");
    const buffer = await file!.toBuffer();
    assertOrThrow(buffer.length > 0, 400, "Empty file");
    assertOrThrow(buffer.length <= app.env.PATIENT_DOCUMENT_MAX_BYTES, 413, "Image is too large");

    const key = `banners/${randomUUID()}-${fileName.replace(/[^A-Za-z0-9._-]/g, "_").slice(-120)}`;
    await putDocument(app.env, key, buffer, contentType!);
    const inserted = await app.db
      .insert(banners)
      .values({ title: query.title || null, imageKey: key, contentType: contentType!, targetUrl: query.targetUrl || null, sortOrder: query.sortOrder ?? 0 })
      .returning({ id: banners.id });
    return reply.code(201).send({ id: inserted[0].id });
  });

  app.patch("/banners/:id", { preHandler: app.authenticatePlatformAdmin }, async (request) => {
    const id = Number((request.params as { id: string }).id);
    assertOrThrow(Number.isInteger(id), 400, "Invalid banner id");
    const body = parseOrThrowValidation(bannerUpdateSchema, request.body);
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (body.title !== undefined) set.title = body.title || null;
    if (body.targetUrl !== undefined) set.targetUrl = body.targetUrl || null;
    if (body.sortOrder !== undefined) set.sortOrder = body.sortOrder;
    if (body.isActive !== undefined) set.isActive = body.isActive;
    await app.db.update(banners).set(set).where(eq(banners.id, id));
    return { ok: true };
  });

  app.delete("/banners/:id", { preHandler: app.authenticatePlatformAdmin }, async (request) => {
    const id = Number((request.params as { id: string }).id);
    assertOrThrow(Number.isInteger(id), 400, "Invalid banner id");
    await app.db.delete(banners).where(eq(banners.id, id));
    return { ok: true };
  });

  app.get("/banners/:id/image", { preHandler: app.authenticatePlatformAdmin }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    assertOrThrow(Number.isInteger(id), 400, "Invalid banner id");
    const rows = await app.db.select({ imageKey: banners.imageKey, contentType: banners.contentType }).from(banners).where(eq(banners.id, id)).limit(1);
    assertOrThrow(rows.length === 1, 404, "Banner not found");
    const buffer = await getDocument(app.env, rows[0].imageKey);
    return reply.header("Content-Type", rows[0].contentType).header("Cache-Control", "no-store").send(buffer);
  });
};

export default adminRoutes;
