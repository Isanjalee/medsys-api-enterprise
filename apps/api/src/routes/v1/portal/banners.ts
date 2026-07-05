import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { banners } from "@medsys/db";
import { assertOrThrow } from "../../../lib/http-error.js";
import { getDocument } from "../../../lib/s3.js";

// Read-only banners for the patient home carousel. Managed by the platform admin (see admin.ts).
const portalBannersRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticatePatient);

  app.get("/", async () => {
    const rows = await app.readDb
      .select({ id: banners.id, title: banners.title, targetUrl: banners.targetUrl })
      .from(banners)
      .where(eq(banners.isActive, true))
      .orderBy(asc(banners.sortOrder), asc(banners.id));

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      targetUrl: r.targetUrl,
      // Same-origin image the carousel can render; the BFF proxies it with the patient token.
      imageUrl: `/api/portal/banners/${r.id}/image`
    }));
  });

  app.get("/:id/image", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    assertOrThrow(Number.isInteger(id), 400, "Invalid banner id");
    const rows = await app.readDb
      .select({ imageKey: banners.imageKey, contentType: banners.contentType })
      .from(banners)
      .where(and(eq(banners.id, id), eq(banners.isActive, true), isNotNull(banners.imageKey)))
      .limit(1);
    assertOrThrow(rows.length === 1, 404, "Banner not found");
    const buffer = await getDocument(app.env, rows[0].imageKey);
    return reply
      .header("Content-Type", rows[0].contentType)
      .header("Cache-Control", "public, max-age=300")
      .send(buffer);
  });
};

export default portalBannersRoutes;
