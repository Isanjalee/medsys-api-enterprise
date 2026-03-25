import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { inventoryItems, inventoryMovements } from "@medsys/db";
import {
  createInventoryItemSchema,
  createInventoryMovementSchema,
  idParamSchema,
  searchInventoryQuerySchema,
  updateInventoryItemSchema
} from "@medsys/validation";
import { assertOrThrow, parseOrThrowValidation } from "../../lib/http-error.js";
import { writeAuditLog } from "../../lib/audit.js";
import { applyRouteDocs } from "../../lib/route-docs.js";

const createInventoryItemBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "category", "unit"],
  properties: {
    sku: { type: "string", nullable: true },
    name: { type: "string" },
    category: { type: "string", enum: ["medicine", "consumable", "equipment", "other"] },
    unit: { type: "string" },
    stock: { type: "number", minimum: 0 },
    reorderLevel: { type: "number", minimum: 0 },
    isActive: { type: "boolean" }
  },
  example: {
    sku: "PCM-500",
    name: "Paracetamol 500mg",
    category: "medicine",
    unit: "tablet",
    stock: 100,
    reorderLevel: 20,
    isActive: true
  }
} as const;

const inventorySearchQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["q"],
  properties: {
    q: { type: "string", minLength: 1 },
    limit: { type: "integer", minimum: 1, maximum: 50, nullable: true },
    category: { type: "string", enum: ["medicine", "consumable", "equipment", "other"], nullable: true },
    activeOnly: { type: "boolean", nullable: true }
  }
} as const;

const inventorySearchResponseSchema = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["id", "sku", "name", "category", "unit", "stock", "reorderLevel", "isActive"],
    properties: {
      id: { type: "integer" },
      sku: { type: "string", nullable: true },
      name: { type: "string" },
      category: { type: "string", enum: ["medicine", "consumable", "equipment", "other"] },
      unit: { type: "string" },
      stock: { type: "string" },
      reorderLevel: { type: "string" },
      isActive: { type: "boolean" }
    }
  },
  example: [
    {
      id: 12,
      sku: "PCM-500",
      name: "Paracetamol 500mg",
      category: "medicine",
      unit: "tablet",
      stock: "40",
      reorderLevel: "5",
      isActive: true
    }
  ]
} as const;

const messageErrorResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["message"],
  properties: {
    message: { type: "string" }
  }
} as const;

const inventoryRoutes: FastifyPluginAsync = async (app) => {
  applyRouteDocs(app, "Inventory", "InventoryController", {
    "GET /": {
      operationId: "InventoryController_findAll",
      summary: "List inventory items"
    },
    "GET /search": {
      operationId: "InventoryController_search",
      summary: "Search inventory items for assistant dispense matching"
    },
    "POST /": {
      operationId: "InventoryController_create",
      summary: "Create inventory item",
      bodySchema: createInventoryItemBodySchema,
      bodyExample: createInventoryItemBodySchema.example
    },
    "PATCH /:id": {
      operationId: "InventoryController_update",
      summary: "Update inventory item",
      bodySchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          sku: { type: "string", nullable: true },
          name: { type: "string" },
          category: { type: "string", enum: ["medicine", "consumable", "equipment", "other"] },
          unit: { type: "string" },
          reorderLevel: { type: "number", minimum: 0 },
          isActive: { type: "boolean" }
        }
      },
      bodyExample: {
        name: "Paracetamol 500mg",
        reorderLevel: 25,
        isActive: true
      }
    },
    "POST /:id/movements": {
      operationId: "InventoryController_createMovement",
      summary: "Create inventory stock movement",
      bodySchema: {
        type: "object",
        additionalProperties: false,
        required: ["quantity"],
        anyOf: [{ required: ["movementType"] }, { required: ["type"] }],
        properties: {
          movementType: { type: "string", enum: ["in", "out", "adjustment"] },
          type: { type: "string", enum: ["in", "out", "adjustment"] },
          quantity: { type: "number", minimum: 0.01 },
          note: { type: "string", nullable: true },
          referenceType: { type: "string", nullable: true },
          referenceId: { type: "integer", minimum: 1, nullable: true }
        }
      },
      bodyExamples: {
        aliasType: {
          summary: "Frontend alias payload",
          value: {
            type: "in",
            quantity: 50,
            note: "Stock adjustment",
            referenceType: "adjustment",
            referenceId: 1
          }
        },
        canonical: {
          summary: "Canonical API payload",
          value: {
            movementType: "in",
            quantity: 50,
            referenceType: "adjustment",
            referenceId: 1
          }
        }
      }
    },
    "GET /:id/movements": {
      operationId: "InventoryController_listMovements",
      summary: "List inventory movements"
    }
  });

  app.addHook("preHandler", app.authenticate);

  app.get(
    "/search",
    {
      preHandler: app.authorizePermissions(["inventory.read"]),
      schema: {
        tags: ["Inventory"],
        operationId: "InventoryController_search",
        summary: "Search inventory items for assistant dispense matching",
        querystring: inventorySearchQuerySchema,
        response: {
          200: inventorySearchResponseSchema,
          400: {
            ...messageErrorResponseSchema,
            example: { message: "Invalid inventory search query" }
          },
          403: {
            ...messageErrorResponseSchema,
            example: { message: "Forbidden" }
          }
        }
      }
    },
    async (request) => {
      const actor = request.actor!;
      const query = parseOrThrowValidation(searchInventoryQuerySchema, request.query ?? {});
    const pattern = `%${query.q}%`;
    const limit = query.limit ?? 10;

    const conditions = [
      eq(inventoryItems.organizationId, actor.organizationId),
      or(ilike(inventoryItems.name, pattern), ilike(inventoryItems.sku, pattern))
    ];

    if (query.category) {
      conditions.push(eq(inventoryItems.category, query.category));
    }

    if (query.activeOnly) {
      conditions.push(eq(inventoryItems.isActive, true));
      conditions.push(isNull(inventoryItems.deletedAt));
    }

    return app.readDb
      .select({
        id: inventoryItems.id,
        sku: inventoryItems.sku,
        name: inventoryItems.name,
        category: inventoryItems.category,
        unit: inventoryItems.unit,
        stock: inventoryItems.stock,
        reorderLevel: inventoryItems.reorderLevel,
        isActive: inventoryItems.isActive
      })
      .from(inventoryItems)
      .where(and(...conditions))
      .orderBy(inventoryItems.name)
      .limit(limit);
    }
  );

  app.get("/", { preHandler: app.authorizePermissions(["inventory.read"]) }, async (request) => {
    const actor = request.actor!;
    return app.readDb
      .select()
      .from(inventoryItems)
      .where(and(eq(inventoryItems.organizationId, actor.organizationId), isNull(inventoryItems.deletedAt)))
      .orderBy(inventoryItems.name);
  });

  app.post(
    "/",
    {
      preHandler: app.authorizePermissions(["inventory.write"]),
      schema: {
        tags: ["Inventory"],
        operationId: "InventoryController_create",
        summary: "Create inventory item",
        body: createInventoryItemBodySchema
      }
    },
    async (request, reply) => {
      const actor = request.actor!;
      const payload = parseOrThrowValidation(createInventoryItemSchema.strict(), request.body);
      const inserted = await app.db
      .insert(inventoryItems)
      .values({
        organizationId: actor.organizationId,
        sku: payload.sku ?? null,
        name: payload.name,
        category: payload.category,
        unit: payload.unit,
        stock: (payload.stock ?? 0).toString(),
        reorderLevel: (payload.reorderLevel ?? 0).toString(),
        isActive: payload.isActive ?? true
      })
      .returning();

    await writeAuditLog(request, {
      entityType: "inventory_item",
      action: "create",
      entityId: inserted[0].id
    });
      return reply.code(201).send(inserted[0]);
    }
  );

  app.patch("/:id", { preHandler: app.authorizePermissions(["inventory.write"]) }, async (request) => {
    const actor = request.actor!;
    const { id } = parseOrThrowValidation(idParamSchema, request.params);
    const body = parseOrThrowValidation(updateInventoryItemSchema, request.body);

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.sku !== undefined) patch.sku = body.sku;
    if (body.name !== undefined) patch.name = body.name;
    if (body.category !== undefined) patch.category = body.category;
    if (body.unit !== undefined) patch.unit = body.unit;
    if (body.reorderLevel !== undefined) patch.reorderLevel = body.reorderLevel.toString();
    if (body.isActive !== undefined) patch.isActive = body.isActive;

    const updated = await app.db
      .update(inventoryItems)
      .set(patch)
      .where(and(eq(inventoryItems.id, id), eq(inventoryItems.organizationId, actor.organizationId)))
      .returning();
    assertOrThrow(updated.length === 1, 404, "Inventory item not found");

    await writeAuditLog(request, {
      entityType: "inventory_item",
      action: "update",
      entityId: id
    });
    return updated[0];
  });

  app.post(
    "/:id/movements",
    {
      preHandler: [app.authorizePermissions(["inventory.write"]), app.enforceSensitiveRateLimit("inventory.write")]
    },
    async (request, reply) => {
      const actor = request.actor!;
      const { id } = parseOrThrowValidation(idParamSchema, request.params);
      const rawBody = request.body as Record<string, unknown>;
      const body = parseOrThrowValidation(createInventoryMovementSchema, {
        movementType: rawBody?.movementType ?? rawBody?.type,
        quantity: rawBody?.quantity,
        referenceType: rawBody?.referenceType,
        referenceId: rawBody?.referenceId
      });

      const movement = await app.db.transaction(async (tx) => {
        const item = await tx
          .select({ id: inventoryItems.id, stock: inventoryItems.stock })
          .from(inventoryItems)
          .where(and(eq(inventoryItems.id, id), eq(inventoryItems.organizationId, actor.organizationId)))
          .limit(1);
        assertOrThrow(item.length === 1, 404, "Inventory item not found");

        if (body.movementType === "in") {
          await tx
            .update(inventoryItems)
            .set({ stock: sql`${inventoryItems.stock} + ${body.quantity}`, updatedAt: new Date() })
            .where(eq(inventoryItems.id, id));
        } else {
          const current = Number(item[0].stock);
          assertOrThrow(current >= body.quantity, 409, "Insufficient stock");
          await tx
            .update(inventoryItems)
            .set({ stock: sql`${inventoryItems.stock} - ${body.quantity}`, updatedAt: new Date() })
            .where(eq(inventoryItems.id, id));
        }

        const rows = await tx
          .insert(inventoryMovements)
          .values({
            organizationId: actor.organizationId,
            inventoryItemId: id,
            movementType: body.movementType,
            quantity: body.quantity.toString(),
            referenceType: body.referenceType ?? null,
            referenceId: body.referenceId ?? null,
            createdById: actor.userId
          })
          .returning();
        return rows[0];
      });

      await writeAuditLog(request, {
        entityType: "inventory_movement",
        action: "create",
        entityId: movement.id
      });
      return reply.code(201).send(movement);
    }
  );

  app.get("/:id/movements", { preHandler: app.authorizePermissions(["inventory.read"]) }, async (request) => {
    const actor = request.actor!;
    const { id } = parseOrThrowValidation(idParamSchema, request.params);
    return app.readDb
      .select()
      .from(inventoryMovements)
      .where(and(eq(inventoryMovements.inventoryItemId, id), eq(inventoryMovements.organizationId, actor.organizationId)))
      .orderBy(desc(inventoryMovements.createdAt));
  });
};

export default inventoryRoutes;
