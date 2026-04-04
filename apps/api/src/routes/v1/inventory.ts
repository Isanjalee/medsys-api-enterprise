import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { inventoryItems, inventoryMovements } from "@medsys/db";
import {
  createInventoryItemSchema,
  createInventoryMovementSchema,
  idParamSchema,
  inventoryAlertsQuerySchema,
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
    genericName: { type: "string", nullable: true },
    category: { type: "string", enum: ["medicine", "consumable", "equipment", "other"] },
    subcategory: { type: "string", nullable: true },
    description: { type: "string", nullable: true },
    dosageForm: { type: "string", nullable: true },
    strength: { type: "string", nullable: true },
    unit: { type: "string" },
    route: { type: "string", nullable: true },
    prescriptionType: { type: "string", enum: ["clinical", "outside", "both"], nullable: true },
    packageUnit: { type: "string", nullable: true },
    packageSize: { type: "number", minimum: 0.01, nullable: true },
    brandName: { type: "string", nullable: true },
    supplierName: { type: "string", nullable: true },
    leadTimeDays: { type: "integer", minimum: 0, nullable: true },
    stock: { type: "number", minimum: 0 },
    reorderLevel: { type: "number", minimum: 0 },
    minStockLevel: { type: "number", minimum: 0, nullable: true },
    maxStockLevel: { type: "number", minimum: 0, nullable: true },
    expiryDate: { type: "string", format: "date", nullable: true },
    batchNo: { type: "string", nullable: true },
    storageLocation: { type: "string", nullable: true },
    directDispenseAllowed: { type: "boolean" },
    isAntibiotic: { type: "boolean" },
    isControlled: { type: "boolean" },
    isPediatricSafe: { type: "boolean" },
    requiresPrescription: { type: "boolean" },
    clinicUseOnly: { type: "boolean" },
    notes: { type: "string", nullable: true },
    isActive: { type: "boolean" }
  },
  example: {
    sku: "PCM-500",
    name: "Paracetamol 500mg",
    genericName: "Paracetamol",
    category: "medicine",
    subcategory: "tablet",
    description: "Common fever and pain relief item",
    dosageForm: "tablet",
    strength: "500mg",
    unit: "tablet",
    route: "oral",
    prescriptionType: "both",
    packageUnit: "box",
    packageSize: 100,
    brandName: "Acme Pharma",
    supplierName: "MediSupply Lanka",
    leadTimeDays: 7,
    stock: 100,
    reorderLevel: 20,
    minStockLevel: 10,
    maxStockLevel: 500,
    expiryDate: "2026-12-31",
    batchNo: "BATCH-001",
    storageLocation: "Shelf A",
    directDispenseAllowed: true,
    isAntibiotic: false,
    isControlled: false,
    isPediatricSafe: true,
    requiresPrescription: true,
    clinicUseOnly: false,
    notes: "Monitor stock before peak flu season",
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
      genericName: { type: "string", nullable: true },
      category: { type: "string", enum: ["medicine", "consumable", "equipment", "other"] },
      subcategory: { type: "string", nullable: true },
      description: { type: "string", nullable: true },
      dosageForm: { type: "string", nullable: true },
      strength: { type: "string", nullable: true },
      unit: { type: "string" },
      route: { type: "string", nullable: true },
      prescriptionType: { type: "string", nullable: true },
      packageUnit: { type: "string", nullable: true },
      packageSize: { type: "string", nullable: true },
      brandName: { type: "string", nullable: true },
      supplierName: { type: "string", nullable: true },
      leadTimeDays: { type: "integer", nullable: true },
      stock: { type: "string" },
      reorderLevel: { type: "string" },
      minStockLevel: { type: "string", nullable: true },
      maxStockLevel: { type: "string", nullable: true },
      expiryDate: { type: "string", nullable: true },
      batchNo: { type: "string", nullable: true },
      storageLocation: { type: "string", nullable: true },
      directDispenseAllowed: { type: "boolean" },
      isAntibiotic: { type: "boolean" },
      isControlled: { type: "boolean" },
      isPediatricSafe: { type: "boolean" },
      requiresPrescription: { type: "boolean" },
      clinicUseOnly: { type: "boolean" },
      notes: { type: "string", nullable: true },
      stockStatus: { type: "string" },
      isActive: { type: "boolean" }
    }
  },
  example: [
    {
      id: 12,
      sku: "PCM-500",
      name: "Paracetamol 500mg",
      genericName: "Paracetamol",
      category: "medicine",
      subcategory: "tablet",
      dosageForm: "tablet",
      strength: "500mg",
      unit: "tablet",
      route: "oral",
      prescriptionType: "both",
      packageUnit: "box",
      packageSize: "100",
      brandName: "Acme Pharma",
      supplierName: "MediSupply Lanka",
      leadTimeDays: 7,
      stock: "40",
      reorderLevel: "5",
      minStockLevel: "2",
      maxStockLevel: "200",
      expiryDate: "2026-12-31",
      batchNo: "BATCH-001",
      storageLocation: "Shelf A",
      directDispenseAllowed: true,
      isAntibiotic: false,
      isControlled: false,
      isPediatricSafe: true,
      requiresPrescription: true,
      clinicUseOnly: false,
      notes: "Fast-moving fever medication",
      stockStatus: "in_stock",
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

const defaultMovementReason = (movementType: "in" | "out" | "adjustment"): string =>
  movementType === "in" ? "purchase" : movementType === "out" ? "dispense" : "adjustment";

const expiryWarningDays = 30;

const inventoryStockStatus = (item: {
  stock: string | number;
  reorderLevel: string | number;
  expiryDate?: string | Date | null;
}): "in_stock" | "low_stock" | "out_of_stock" | "near_expiry" | "expired" => {
  const stock = Number(item.stock ?? 0);
  const reorderLevel = Number(item.reorderLevel ?? 0);
  const expiryDate = item.expiryDate ? new Date(item.expiryDate) : null;
  const now = new Date();

  if (expiryDate) {
    const expiryStart = new Date(`${expiryDate.toISOString().slice(0, 10)}T00:00:00.000Z`);
    const daysToExpiry = (expiryStart.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);
    if (daysToExpiry < 0) {
      return "expired";
    }
    if (daysToExpiry <= expiryWarningDays) {
      return "near_expiry";
    }
  }

  if (stock <= 0) {
    return "out_of_stock";
  }
  if (stock <= reorderLevel) {
    return "low_stock";
  }
  return "in_stock";
};

const serializeInventoryItem = <T extends Record<string, unknown>>(item: T) => ({
  ...item,
  stockStatus: inventoryStockStatus({
    stock: item.stock as string | number,
    reorderLevel: item.reorderLevel as string | number,
    expiryDate: (item.expiryDate as string | Date | null | undefined) ?? null
  })
});

const inventoryItemSelect = {
  id: inventoryItems.id,
  organizationId: inventoryItems.organizationId,
  sku: inventoryItems.sku,
  name: inventoryItems.name,
  genericName: inventoryItems.genericName,
  category: inventoryItems.category,
  subcategory: inventoryItems.subcategory,
  description: inventoryItems.description,
  dosageForm: inventoryItems.dosageForm,
  strength: inventoryItems.strength,
  unit: inventoryItems.unit,
  route: inventoryItems.route,
  prescriptionType: inventoryItems.prescriptionType,
  packageUnit: inventoryItems.packageUnit,
  packageSize: inventoryItems.packageSize,
  brandName: inventoryItems.brandName,
  supplierName: inventoryItems.supplierName,
  leadTimeDays: inventoryItems.leadTimeDays,
  stock: inventoryItems.stock,
  reorderLevel: inventoryItems.reorderLevel,
  minStockLevel: inventoryItems.minStockLevel,
  maxStockLevel: inventoryItems.maxStockLevel,
  expiryDate: inventoryItems.expiryDate,
  batchNo: inventoryItems.batchNo,
  storageLocation: inventoryItems.storageLocation,
  directDispenseAllowed: inventoryItems.directDispenseAllowed,
  isAntibiotic: inventoryItems.isAntibiotic,
  isControlled: inventoryItems.isControlled,
  isPediatricSafe: inventoryItems.isPediatricSafe,
  requiresPrescription: inventoryItems.requiresPrescription,
  clinicUseOnly: inventoryItems.clinicUseOnly,
  notes: inventoryItems.notes,
  isActive: inventoryItems.isActive,
  createdAt: inventoryItems.createdAt,
  updatedAt: inventoryItems.updatedAt,
  deletedAt: inventoryItems.deletedAt
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
    "GET /alerts": {
      operationId: "InventoryController_alerts",
      summary: "Get inventory stock alerts and restock suggestions"
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
          genericName: { type: "string", nullable: true },
          category: { type: "string", enum: ["medicine", "consumable", "equipment", "other"] },
          subcategory: { type: "string", nullable: true },
          description: { type: "string", nullable: true },
          dosageForm: { type: "string", nullable: true },
          strength: { type: "string", nullable: true },
          unit: { type: "string" },
          route: { type: "string", nullable: true },
          prescriptionType: { type: "string", enum: ["clinical", "outside", "both"], nullable: true },
          packageUnit: { type: "string", nullable: true },
          packageSize: { type: "number", minimum: 0.01, nullable: true },
          brandName: { type: "string", nullable: true },
          supplierName: { type: "string", nullable: true },
          leadTimeDays: { type: "integer", minimum: 0, nullable: true },
          reorderLevel: { type: "number", minimum: 0 },
          minStockLevel: { type: "number", minimum: 0, nullable: true },
          maxStockLevel: { type: "number", minimum: 0, nullable: true },
          expiryDate: { type: "string", format: "date", nullable: true },
          batchNo: { type: "string", nullable: true },
          storageLocation: { type: "string", nullable: true },
          directDispenseAllowed: { type: "boolean" },
          isAntibiotic: { type: "boolean" },
          isControlled: { type: "boolean" },
          isPediatricSafe: { type: "boolean" },
          requiresPrescription: { type: "boolean" },
          clinicUseOnly: { type: "boolean" },
          notes: { type: "string", nullable: true },
          isActive: { type: "boolean" }
        }
      },
      bodyExample: {
        name: "Paracetamol 500mg",
        genericName: "Paracetamol",
        dosageForm: "tablet",
        strength: "500mg",
        reorderLevel: 25,
        directDispenseAllowed: true,
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

  app.get("/alerts", { preHandler: app.authorizePermissions(["inventory.read"]) }, async (request) => {
    const actor = request.actor!;
    const query = parseOrThrowValidation(inventoryAlertsQuerySchema, request.query ?? {});
    const rangeDays = query.days ?? 30;
    const now = new Date();
    const start = new Date(now.getTime() - rangeDays * 24 * 60 * 60 * 1000);

    const conditions = [eq(inventoryItems.organizationId, actor.organizationId), isNull(inventoryItems.deletedAt)];
    if (query.category) {
      conditions.push(eq(inventoryItems.category, query.category));
    }
    if (query.activeOnly) {
      conditions.push(eq(inventoryItems.isActive, true));
    }

    const items = await app.readDb
      .select()
      .from(inventoryItems)
      .where(and(...conditions))
      .orderBy(inventoryItems.name);

    const itemIds = items.map((item) => item.id);
    const movements =
      itemIds.length === 0
        ? []
        : await app.readDb
            .select()
            .from(inventoryMovements)
            .where(
              and(
                eq(inventoryMovements.organizationId, actor.organizationId),
                sql`${inventoryMovements.createdAt} >= ${start}`,
                sql`${inventoryMovements.createdAt} <= ${now}`,
                or(
                  eq(inventoryMovements.movementType, "out"),
                  eq(inventoryMovements.movementType, "adjustment"),
                  eq(inventoryMovements.movementType, "in")
                )
              )
            );

    const movementByItemId = new Map<number, Array<(typeof movements)[number]>>();
    for (const movement of movements) {
      const current = movementByItemId.get(movement.inventoryItemId) ?? [];
      current.push(movement);
      movementByItemId.set(movement.inventoryItemId, current);
    }

    const itemAnalytics = items.map((item) => {
      const stock = Number(item.stock);
      const reorderLevel = Number(item.reorderLevel);
      const itemMovements = movementByItemId.get(item.id) ?? [];
      const outgoing = itemMovements.filter((movement) => movement.movementType === "out");
      const totalOutgoing = outgoing.reduce((sum, movement) => sum + Number(movement.quantity), 0);
      const averageDailyUsage = totalOutgoing / rangeDays;
      const projectedDaysRemaining = averageDailyUsage > 0 ? Math.round((stock / averageDailyUsage) * 10) / 10 : null;
      const leadTimeDays = item.leadTimeDays ?? 7;
      const safetyDays = 5;
      const recommendedStock = averageDailyUsage > 0 ? Math.ceil((leadTimeDays + safetyDays) * averageDailyUsage) : reorderLevel;
      const recommendedReorderQty = Math.max(0, Math.ceil(recommendedStock - stock));
      const lowStock = stock <= reorderLevel;
      const stockoutRisk = projectedDaysRemaining !== null && projectedDaysRemaining <= leadTimeDays + safetyDays;
      const stockStatus = inventoryStockStatus(item);
      const expiryRisk = stockStatus === "near_expiry" || stockStatus === "expired";
      return {
        id: item.id,
        sku: item.sku,
        name: item.name,
        genericName: item.genericName,
        category: item.category,
        subcategory: item.subcategory,
        dosageForm: item.dosageForm,
        strength: item.strength,
        unit: item.unit,
        route: item.route,
        prescriptionType: item.prescriptionType,
        packageUnit: item.packageUnit,
        packageSize: item.packageSize,
        brandName: item.brandName,
        supplierName: item.supplierName,
        leadTimeDays,
        stock,
        reorderLevel,
        minStockLevel: item.minStockLevel,
        maxStockLevel: item.maxStockLevel,
        expiryDate: item.expiryDate,
        batchNo: item.batchNo,
        storageLocation: item.storageLocation,
        directDispenseAllowed: item.directDispenseAllowed,
        stockStatus,
        totalOutgoing,
        averageDailyUsage: Math.round(averageDailyUsage * 100) / 100,
        projectedDaysRemaining,
        recommendedReorderQty,
        lowStock,
        stockoutRisk,
        expiryRisk
      };
    });

    return {
      generatedAt: now.toISOString(),
      rangeDays,
      summary: {
        totalItems: itemAnalytics.length,
        lowStockCount: itemAnalytics.filter((item) => item.lowStock).length,
        stockoutRiskCount: itemAnalytics.filter((item) => item.stockoutRisk).length,
        nearExpiryCount: itemAnalytics.filter((item) => item.stockStatus === "near_expiry").length,
        expiredCount: itemAnalytics.filter((item) => item.stockStatus === "expired").length,
        fastMovingCount: itemAnalytics.filter((item) => item.averageDailyUsage >= 1).length
      },
      alerts: itemAnalytics
        .filter((item) => item.lowStock || item.stockoutRisk || item.expiryRisk)
        .sort(
          (left, right) =>
            Number(right.stockStatus === "expired") - Number(left.stockStatus === "expired") ||
            Number(right.stockoutRisk) - Number(left.stockoutRisk) ||
            Number(left.stock) - Number(right.stock)
        )
        .slice(0, 20),
      recommendations: itemAnalytics
        .filter((item) => item.recommendedReorderQty > 0)
        .sort((left, right) => right.recommendedReorderQty - left.recommendedReorderQty)
        .slice(0, 20)
    };
  });

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
      or(
        ilike(inventoryItems.name, pattern),
        ilike(inventoryItems.sku, pattern),
        ilike(inventoryItems.genericName, pattern),
        ilike(inventoryItems.brandName, pattern)
      )
    ];

    if (query.category) {
      conditions.push(eq(inventoryItems.category, query.category));
    }

    if (query.activeOnly) {
      conditions.push(eq(inventoryItems.isActive, true));
      conditions.push(isNull(inventoryItems.deletedAt));
    }

    return app.readDb
      .select(inventoryItemSelect)
      .from(inventoryItems)
      .where(and(...conditions))
      .orderBy(inventoryItems.name)
      .limit(limit)
      .then((rows) => rows.map(serializeInventoryItem));
    }
  );

  app.get("/", { preHandler: app.authorizePermissions(["inventory.read"]) }, async (request) => {
    const actor = request.actor!;
    return app.readDb
      .select(inventoryItemSelect)
      .from(inventoryItems)
      .where(and(eq(inventoryItems.organizationId, actor.organizationId), isNull(inventoryItems.deletedAt)))
      .orderBy(inventoryItems.name)
      .then((rows) => rows.map(serializeInventoryItem));
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
        genericName: payload.genericName ?? null,
        category: payload.category,
        subcategory: payload.subcategory ?? null,
        description: payload.description ?? null,
        dosageForm: payload.dosageForm ?? null,
        strength: payload.strength ?? null,
        unit: payload.unit,
        route: payload.route ?? null,
        prescriptionType: payload.prescriptionType ?? null,
        packageUnit: payload.packageUnit ?? null,
        packageSize: payload.packageSize?.toString() ?? null,
        brandName: payload.brandName ?? null,
        supplierName: payload.supplierName ?? null,
        leadTimeDays: payload.leadTimeDays ?? null,
        stock: (payload.stock ?? 0).toString(),
        reorderLevel: (payload.reorderLevel ?? 0).toString(),
        minStockLevel: payload.minStockLevel?.toString() ?? null,
        maxStockLevel: payload.maxStockLevel?.toString() ?? null,
        expiryDate: payload.expiryDate ?? null,
        batchNo: payload.batchNo ?? null,
        storageLocation: payload.storageLocation ?? null,
        directDispenseAllowed: payload.directDispenseAllowed ?? false,
        isAntibiotic: payload.isAntibiotic ?? false,
        isControlled: payload.isControlled ?? false,
        isPediatricSafe: payload.isPediatricSafe ?? false,
        requiresPrescription: payload.requiresPrescription ?? true,
        clinicUseOnly: payload.clinicUseOnly ?? false,
        notes: payload.notes ?? null,
        isActive: payload.isActive ?? true
      })
      .returning();

    await writeAuditLog(request, {
      entityType: "inventory_item",
      action: "create",
      entityId: inserted[0].id
    });
      return reply.code(201).send(serializeInventoryItem(inserted[0]));
    }
  );

  app.patch("/:id", { preHandler: app.authorizePermissions(["inventory.write"]) }, async (request) => {
    const actor = request.actor!;
    const { id } = parseOrThrowValidation(idParamSchema, request.params);
    const body = parseOrThrowValidation(updateInventoryItemSchema, request.body);

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.sku !== undefined) patch.sku = body.sku;
    if (body.name !== undefined) patch.name = body.name;
    if (body.genericName !== undefined) patch.genericName = body.genericName;
    if (body.category !== undefined) patch.category = body.category;
    if (body.subcategory !== undefined) patch.subcategory = body.subcategory;
    if (body.description !== undefined) patch.description = body.description;
    if (body.dosageForm !== undefined) patch.dosageForm = body.dosageForm;
    if (body.strength !== undefined) patch.strength = body.strength;
    if (body.unit !== undefined) patch.unit = body.unit;
    if (body.route !== undefined) patch.route = body.route;
    if (body.prescriptionType !== undefined) patch.prescriptionType = body.prescriptionType;
    if (body.packageUnit !== undefined) patch.packageUnit = body.packageUnit;
    if (body.packageSize !== undefined) patch.packageSize = body.packageSize?.toString() ?? null;
    if (body.brandName !== undefined) patch.brandName = body.brandName;
    if (body.supplierName !== undefined) patch.supplierName = body.supplierName;
    if (body.leadTimeDays !== undefined) patch.leadTimeDays = body.leadTimeDays;
    if (body.reorderLevel !== undefined) patch.reorderLevel = body.reorderLevel.toString();
    if (body.minStockLevel !== undefined) patch.minStockLevel = body.minStockLevel?.toString() ?? null;
    if (body.maxStockLevel !== undefined) patch.maxStockLevel = body.maxStockLevel?.toString() ?? null;
    if (body.expiryDate !== undefined) patch.expiryDate = body.expiryDate;
    if (body.batchNo !== undefined) patch.batchNo = body.batchNo;
    if (body.storageLocation !== undefined) patch.storageLocation = body.storageLocation;
    if (body.directDispenseAllowed !== undefined) patch.directDispenseAllowed = body.directDispenseAllowed;
    if (body.isAntibiotic !== undefined) patch.isAntibiotic = body.isAntibiotic;
    if (body.isControlled !== undefined) patch.isControlled = body.isControlled;
    if (body.isPediatricSafe !== undefined) patch.isPediatricSafe = body.isPediatricSafe;
    if (body.requiresPrescription !== undefined) patch.requiresPrescription = body.requiresPrescription;
    if (body.clinicUseOnly !== undefined) patch.clinicUseOnly = body.clinicUseOnly;
    if (body.notes !== undefined) patch.notes = body.notes;
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
    return serializeInventoryItem(updated[0]);
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
        reason: rawBody?.reason,
        note: rawBody?.note,
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
            reason: body.reason ?? defaultMovementReason(body.movementType),
            quantity: body.quantity.toString(),
            note: body.note ?? null,
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
