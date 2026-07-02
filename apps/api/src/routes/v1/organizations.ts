import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { organizations } from "@medsys/db";
import { assertOrThrow, parseOrThrowValidation } from "../../lib/http-error.js";
import { writeAuditLog } from "../../lib/audit.js";
import { applyRouteDocs } from "../../lib/route-docs.js";

const updateOperatingModeSchema = z
  .object({
    operatingMode: z.enum(["standard", "step_up"])
  })
  .strict();

const updateOperatingModeBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["operatingMode"],
  properties: {
    operatingMode: { type: "string", enum: ["standard", "step_up"] }
  },
  example: { operatingMode: "step_up" }
};

// Pages the owner can grant/deny assistants. null on the org means "all pages".
const ASSISTANT_TOGGLEABLE_PAGES = [
  "assistant",
  "patient",
  "inventory",
  "analytics",
  "tasks",
  "ai",
  "documents"
] as const;

const updateAssistantAccessSchema = z
  .object({
    assistantAccess: z.array(z.enum(ASSISTANT_TOGGLEABLE_PAGES)).nullable()
  })
  .strict();

const serializeOrganization = (row: {
  id: string;
  slug: string;
  name: string;
  operatingMode: string | null;
  assistantAccess?: string[] | null;
}) => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  operating_mode: row.operatingMode ?? "standard",
  // null = all pages allowed for assistants.
  assistant_access: row.assistantAccess ?? null,
  assistant_toggleable_pages: [...ASSISTANT_TOGGLEABLE_PAGES]
});

const organizationRoutes: FastifyPluginAsync = async (app) => {
  applyRouteDocs(app, "Organizations", "OrganizationsController", {
    "GET /current": {
      operationId: "OrganizationsController_current",
      summary: "Get the active organization settings"
    },
    "PATCH /current": {
      operationId: "OrganizationsController_updateCurrent",
      summary: "Update the active organization operating mode (owner only)",
      bodySchema: updateOperatingModeBodySchema,
      bodyExample: updateOperatingModeBodySchema.example
    }
  });

  app.get("/current", { preHandler: app.authenticate }, async (request) => {
    const actor = request.actor!;
    const rows = await app.readDb
      .select({
        id: organizations.id,
        slug: organizations.slug,
        name: organizations.name,
        operatingMode: organizations.operatingMode,
        assistantAccess: organizations.assistantAccess
      })
      .from(organizations)
      .where(eq(organizations.id, actor.organizationId))
      .limit(1);
    assertOrThrow(rows.length === 1, 404, "Organization not found");
    return { organization: serializeOrganization(rows[0]) };
  });

  // Owner sets which pages this clinic's assistants can access (null = all pages).
  app.patch(
    "/current/assistant-access",
    { preHandler: [app.authenticate, app.authorize(["owner"])] },
    async (request) => {
      const actor = request.actor!;
      const payload = parseOrThrowValidation(updateAssistantAccessSchema, request.body);
      const value = payload.assistantAccess ? [...new Set(payload.assistantAccess)] : null;

      const updated = await app.db
        .update(organizations)
        .set({ assistantAccess: value, updatedAt: new Date() })
        .where(eq(organizations.id, actor.organizationId))
        .returning({
          id: organizations.id,
          slug: organizations.slug,
          name: organizations.name,
          operatingMode: organizations.operatingMode,
          assistantAccess: organizations.assistantAccess
        });
      assertOrThrow(updated.length === 1, 404, "Organization not found");

      await writeAuditLog(request, {
        entityType: "organization",
        action: "update_assistant_access",
        payload: { assistantAccess: value }
      });

      return { organization: serializeOrganization(updated[0]) };
    }
  );

  app.patch(
    "/current",
    { preHandler: [app.authenticate, app.authorize(["owner"])] },
    async (request) => {
      const actor = request.actor!;
      const payload = parseOrThrowValidation(updateOperatingModeSchema, request.body);

      const updated = await app.db
        .update(organizations)
        .set({ operatingMode: payload.operatingMode, updatedAt: new Date() })
        .where(eq(organizations.id, actor.organizationId))
        .returning({
          id: organizations.id,
          slug: organizations.slug,
          name: organizations.name,
          operatingMode: organizations.operatingMode
        });
      assertOrThrow(updated.length === 1, 404, "Organization not found");

      await writeAuditLog(request, {
        entityType: "organization",
        action: "update_operating_mode",
        payload: { operatingMode: payload.operatingMode }
      });

      return { organization: serializeOrganization(updated[0]) };
    }
  );
};

export default organizationRoutes;
