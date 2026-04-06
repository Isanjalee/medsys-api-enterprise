import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { inventoryBatches, inventoryItems, inventoryMovements } from "@medsys/db";
import {
  adjustInventoryStockSchema,
  createInventoryBatchSchema,
  createInventoryItemSchema,
  createInventoryMovementSchema,
  idParamSchema,
  inventoryAlertsQuerySchema,
  inventoryReportsQuerySchema,
  searchInventoryQuerySchema,
  updateInventoryItemSchema
} from "@medsys/validation";
import { assertOrThrow, parseOrThrowValidation } from "../../lib/http-error.js";
import { writeAuditLog } from "../../lib/audit.js";
import { applyRouteDocs } from "../../lib/route-docs.js";

const nullablePrescriptionTypeSchema = {
  anyOf: [
    { type: "string", enum: ["clinical", "outside", "both"] },
    { type: "null" }
  ]
} as const;

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
    dispenseUnit: { type: "string", nullable: true },
    dispenseUnitSize: { type: "number", minimum: 0.01, nullable: true },
    purchaseUnit: { type: "string", nullable: true },
    purchaseUnitSize: { type: "number", minimum: 0.01, nullable: true },
    route: { type: "string", nullable: true },
    prescriptionType: nullablePrescriptionTypeSchema,
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
    dispenseUnit: "card",
    dispenseUnitSize: 10,
    purchaseUnit: "box",
    purchaseUnitSize: 100,
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
      dispenseUnit: { type: "string", nullable: true },
      dispenseUnitSize: { type: "string", nullable: true },
      purchaseUnit: { type: "string", nullable: true },
      purchaseUnitSize: { type: "string", nullable: true },
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
        dispenseUnit: "card",
        dispenseUnitSize: "10",
        purchaseUnit: "box",
        purchaseUnitSize: "100",
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

const stringifyNumeric = (value: number): string => value.toString();

const toNumeric = (value: string | number | null | undefined): number => Number(value ?? 0);

const roundQuantity = (value: number): number => Math.round(value * 100) / 100;

const resolveMovementBaseQuantity = (
  item: {
    unit: string;
    dispenseUnit: string | null;
    dispenseUnitSize: string | number | null;
    purchaseUnit: string | null;
    purchaseUnitSize: string | number | null;
  },
  quantity: number,
  movementUnit?: string | null
): number => {
  const normalizedUnit = movementUnit?.trim().toLowerCase() ?? item.unit.toLowerCase();
  const baseUnit = item.unit.toLowerCase();
  const dispenseUnit = item.dispenseUnit?.toLowerCase() ?? null;
  const purchaseUnit = item.purchaseUnit?.toLowerCase() ?? null;

  if (normalizedUnit === baseUnit) {
    return quantity;
  }

  if (dispenseUnit && normalizedUnit === dispenseUnit) {
    return quantity * Number(item.dispenseUnitSize ?? 0);
  }

  if (purchaseUnit && normalizedUnit === purchaseUnit) {
    return quantity * Number(item.purchaseUnitSize ?? 0);
  }

  return Number.NaN;
};

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
  }),
  stockSummary: buildInventoryStockSummary(item)
});

const buildInventoryStockSummary = <T extends Record<string, unknown>>(item: T) => {
  const stock = toNumeric(item.stock as string | number | null | undefined);
  const reorderLevel = toNumeric(item.reorderLevel as string | number | null | undefined);
  const dispenseUnitSize = item.dispenseUnitSize ? toNumeric(item.dispenseUnitSize as string | number) : null;
  const purchaseUnitSize = item.purchaseUnitSize ? toNumeric(item.purchaseUnitSize as string | number) : null;
  const shortageToMinimum = Math.max(reorderLevel - stock, 0);

  return {
    currentStock: stringifyNumeric(stock),
    baseUnit: (item.unit as string | undefined) ?? null,
    minimumStock: stringifyNumeric(reorderLevel),
    shortageToMinimum: stringifyNumeric(shortageToMinimum),
    isBelowMinimum: stock <= reorderLevel,
    dispensePackEquivalent:
      dispenseUnitSize && dispenseUnitSize > 0 ? stringifyNumeric(roundQuantity(stock / dispenseUnitSize)) : null,
    purchasePackEquivalent:
      purchaseUnitSize && purchaseUnitSize > 0 ? stringifyNumeric(roundQuantity(stock / purchaseUnitSize)) : null
  };
};

const daysUntilExpiry = (expiryDate?: string | Date | null): number | null => {
  if (!expiryDate) {
    return null;
  }

  const parsed = new Date(expiryDate);
  const expiryStart = new Date(`${parsed.toISOString().slice(0, 10)}T00:00:00.000Z`);
  return Math.floor((expiryStart.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
};

const buildMovementResponse = (
  movement: Record<string, unknown>,
  item: Record<string, unknown>,
  requestedQuantity: number,
  requestedUnit: string,
  baseQuantity: number
) => ({
  movement,
  item: serializeInventoryItem(item),
  conversion: {
    requestedQuantity: stringifyNumeric(requestedQuantity),
    requestedUnit,
    baseQuantity: stringifyNumeric(baseQuantity),
    baseUnit: item.unit
  }
});

const serializeInventoryBatch = <T extends Record<string, unknown>>(batch: T) => ({
  ...batch,
  quantity: stringifyNumeric(toNumeric(batch.quantity as string | number | null | undefined)),
  daysUntilExpiry: daysUntilExpiry((batch.expiryDate as string | Date | null | undefined) ?? null),
  stockStatus: inventoryStockStatus({
    stock: batch.quantity as string | number,
    reorderLevel: 0,
    expiryDate: (batch.expiryDate as string | Date | null | undefined) ?? null
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
  dispenseUnit: inventoryItems.dispenseUnit,
  dispenseUnitSize: inventoryItems.dispenseUnitSize,
  purchaseUnit: inventoryItems.purchaseUnit,
  purchaseUnitSize: inventoryItems.purchaseUnitSize,
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

const inventoryBatchSelect = {
  id: inventoryBatches.id,
  organizationId: inventoryBatches.organizationId,
  inventoryItemId: inventoryBatches.inventoryItemId,
  batchNo: inventoryBatches.batchNo,
  expiryDate: inventoryBatches.expiryDate,
  quantity: inventoryBatches.quantity,
  supplierName: inventoryBatches.supplierName,
  storageLocation: inventoryBatches.storageLocation,
  receivedAt: inventoryBatches.receivedAt,
  isActive: inventoryBatches.isActive,
  createdAt: inventoryBatches.createdAt,
  updatedAt: inventoryBatches.updatedAt,
  deletedAt: inventoryBatches.deletedAt
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
    "GET /reports": {
      operationId: "InventoryController_reports",
      summary: "Get inventory operational reports and supplier summaries"
    },
    "GET /:id": {
      operationId: "InventoryController_findOne",
      summary: "Get inventory item detail"
    },
    "GET /:id/batches": {
      operationId: "InventoryController_listBatches",
      summary: "List inventory batches for an item"
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
          dispenseUnit: { type: "string", nullable: true },
          dispenseUnitSize: { type: "number", minimum: 0.01, nullable: true },
          purchaseUnit: { type: "string", nullable: true },
          purchaseUnitSize: { type: "number", minimum: 0.01, nullable: true },
          route: { type: "string", nullable: true },
          prescriptionType: nullablePrescriptionTypeSchema,
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
          dispenseUnit: "card",
          dispenseUnitSize: 10,
          purchaseUnit: "box",
          purchaseUnitSize: 100,
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
          movementUnit: { type: "string", nullable: true },
          batchId: { type: "integer", nullable: true },
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
            batchId: 1,
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
            movementUnit: "box",
            batchId: 1,
            referenceType: "adjustment",
            referenceId: 1
          }
        }
      }
    },
    "POST /:id/adjust-stock": {
      operationId: "InventoryController_adjustStock",
      summary: "Adjust inventory to an actual counted stock level",
      bodySchema: {
        type: "object",
        additionalProperties: false,
        required: ["actualStock"],
        properties: {
          actualStock: { type: "number", minimum: 0 },
          note: { type: "string", nullable: true }
        }
      },
      bodyExample: {
        actualStock: 200,
        note: "Cycle count correction"
      }
    },
    "POST /:id/batches": {
      operationId: "InventoryController_createBatch",
      summary: "Create an inventory batch and add its opening stock",
      bodySchema: {
        type: "object",
        additionalProperties: false,
        required: ["batchNo", "quantity"],
        properties: {
          batchNo: { type: "string" },
          expiryDate: { type: "string", format: "date", nullable: true },
          quantity: { type: "number", minimum: 0.01 },
          supplierName: { type: "string", nullable: true },
          storageLocation: { type: "string", nullable: true },
          receivedAt: { type: "string", format: "date-time", nullable: true },
          note: { type: "string", nullable: true }
        }
      },
      bodyExample: {
        batchNo: "PCM-APR-01",
        expiryDate: "2026-12-31",
        quantity: 100,
        supplierName: "MediSupply Lanka",
        storageLocation: "Shelf A",
        note: "Opening batch received"
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
    const nowIso = now.toISOString();
    const startIso = start.toISOString();

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
                sql`${inventoryMovements.createdAt} >= ${startIso}`,
                sql`${inventoryMovements.createdAt} <= ${nowIso}`,
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
      const shortageToMinimum = Math.max(reorderLevel - stock, 0);
      const purchaseUnitSize = item.purchaseUnitSize ? Number(item.purchaseUnitSize) : null;
      const dispenseUnitSize = item.dispenseUnitSize ? Number(item.dispenseUnitSize) : null;
      const expiryDays = daysUntilExpiry(item.expiryDate);
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
        dispenseUnit: item.dispenseUnit,
        dispenseUnitSize: item.dispenseUnitSize,
        purchaseUnit: item.purchaseUnit,
        purchaseUnitSize: item.purchaseUnitSize,
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
        shortageToMinimum,
        daysUntilExpiry: expiryDays,
        suggestedPurchasePacks:
          purchaseUnitSize && purchaseUnitSize > 0 ? Math.ceil(recommendedReorderQty / purchaseUnitSize) : null,
        suggestedDispensePacks:
          dispenseUnitSize && dispenseUnitSize > 0 ? Math.ceil(recommendedReorderQty / dispenseUnitSize) : null,
        lowStock,
        stockoutRisk,
        expiryRisk,
        stockSummary: buildInventoryStockSummary(item)
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

  app.get("/reports", { preHandler: app.authorizePermissions(["inventory.read"]) }, async (request) => {
    const actor = request.actor!;
    const query = parseOrThrowValidation(inventoryReportsQuerySchema, request.query ?? {});
    const rangeDays = query.days ?? 30;
    const now = new Date();
    const start = new Date(now.getTime() - rangeDays * 24 * 60 * 60 * 1000);
    const previousStart = new Date(start.getTime() - rangeDays * 24 * 60 * 60 * 1000);
    const previousStartIso = previousStart.toISOString();

    const itemConditions = [eq(inventoryItems.organizationId, actor.organizationId), isNull(inventoryItems.deletedAt)];
    if (query.activeOnly) {
      itemConditions.push(eq(inventoryItems.isActive, true));
    }

    const items = await app.readDb
      .select(inventoryItemSelect)
      .from(inventoryItems)
      .where(and(...itemConditions))
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
                sql`${inventoryMovements.createdAt} >= ${previousStartIso}`
              )
            );

    const movementsByItemId = new Map<number, Array<(typeof movements)[number]>>();
    for (const movement of movements) {
      const current = movementsByItemId.get(movement.inventoryItemId) ?? [];
      current.push(movement);
      movementsByItemId.set(movement.inventoryItemId, current);
    }

    const itemMetrics = items.map((item) => {
      const stock = toNumeric(item.stock);
      const reorderLevel = toNumeric(item.reorderLevel);
      const itemMovements = movementsByItemId.get(item.id) ?? [];
      const outgoing = itemMovements.filter(
        (movement) => movement.movementType === "out" && new Date(movement.createdAt).getTime() >= start.getTime()
      );
      const totalOutgoing = outgoing.reduce((sum, movement) => sum + toNumeric(movement.quantity), 0);
      const averageDailyUsage = rangeDays > 0 ? totalOutgoing / rangeDays : 0;
      const previousWindowOutgoing = itemMovements
        .filter((movement) => {
          const createdAt = new Date(movement.createdAt);
          return createdAt.getTime() < start.getTime() && createdAt.getTime() >= previousStart.getTime();
        })
        .reduce((sum, movement) => sum + toNumeric(movement.quantity), 0);
      const previousAverageDailyUsage = rangeDays > 0 ? previousWindowOutgoing / rangeDays : 0;

      return {
        id: item.id,
        name: item.name,
        supplierName: item.supplierName ?? "Unassigned",
        stock,
        reorderLevel,
        totalOutgoing,
        averageDailyUsage: roundQuantity(averageDailyUsage),
        previousAverageDailyUsage: roundQuantity(previousAverageDailyUsage),
        lowStock: stock <= reorderLevel,
        deadStock: stock > 0 && itemMovements.length === 0,
        fastMoving: averageDailyUsage >= 1 && averageDailyUsage > previousAverageDailyUsage,
        slowMoving: stock > 0 && averageDailyUsage > 0 && averageDailyUsage < 0.2,
        stockSummary: buildInventoryStockSummary(item)
      };
    });

    const supplierMap = new Map<
      string,
      { supplierName: string; itemCount: number; totalStock: number; lowStockCount: number; recommendedReorderQty: number }
    >();
    for (const item of itemMetrics) {
      const supplier = supplierMap.get(item.supplierName) ?? {
        supplierName: item.supplierName,
        itemCount: 0,
        totalStock: 0,
        lowStockCount: 0,
        recommendedReorderQty: 0
      };
      supplier.itemCount += 1;
      supplier.totalStock += item.stock;
      supplier.lowStockCount += item.lowStock ? 1 : 0;
      supplier.recommendedReorderQty += Math.max(item.reorderLevel - item.stock, 0);
      supplierMap.set(item.supplierName, supplier);
    }

    const expiringBatches = await app.readDb
      .select(inventoryBatchSelect)
      .from(inventoryBatches)
      .where(
        and(
          eq(inventoryBatches.organizationId, actor.organizationId),
          isNull(inventoryBatches.deletedAt),
          sql`${inventoryBatches.expiryDate} IS NOT NULL`,
          sql`${inventoryBatches.expiryDate} <= ${(new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10)}`
        )
      )
      .orderBy(inventoryBatches.expiryDate);

    return {
      generatedAt: now.toISOString(),
      rangeDays,
      supplierSummary: Array.from(supplierMap.values()).sort((left, right) => right.lowStockCount - left.lowStockCount),
      movementVelocity: {
        fastMoving: itemMetrics.filter((item) => item.fastMoving).sort((left, right) => right.averageDailyUsage - left.averageDailyUsage),
        slowMoving: itemMetrics.filter((item) => item.slowMoving).sort((left, right) => left.averageDailyUsage - right.averageDailyUsage),
        deadStock: itemMetrics.filter((item) => item.deadStock).sort((left, right) => right.stock - left.stock)
      },
      expiringBatches: expiringBatches.map(serializeInventoryBatch)
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

  app.get("/:id/batches", { preHandler: app.authorizePermissions(["inventory.read"]) }, async (request) => {
    const actor = request.actor!;
    const { id } = parseOrThrowValidation(idParamSchema, request.params);

    return app.readDb
      .select(inventoryBatchSelect)
      .from(inventoryBatches)
      .where(
        and(
          eq(inventoryBatches.inventoryItemId, id),
          eq(inventoryBatches.organizationId, actor.organizationId),
          isNull(inventoryBatches.deletedAt)
        )
      )
      .orderBy(inventoryBatches.expiryDate, desc(inventoryBatches.createdAt))
      .then((rows) => rows.map(serializeInventoryBatch));
  });

  app.post("/:id/batches", { preHandler: app.authorizePermissions(["inventory.write"]) }, async (request, reply) => {
    const actor = request.actor!;
    const { id } = parseOrThrowValidation(idParamSchema, request.params);
    const body = parseOrThrowValidation(createInventoryBatchSchema, request.body);

    const result = await app.db.transaction(async (tx) => {
      const item = await tx
        .select(inventoryItemSelect)
        .from(inventoryItems)
        .where(and(eq(inventoryItems.id, id), eq(inventoryItems.organizationId, actor.organizationId)))
        .limit(1);
      assertOrThrow(item.length === 1, 404, "Inventory item not found");

      const batchRows = await tx
        .insert(inventoryBatches)
        .values({
          organizationId: actor.organizationId,
          inventoryItemId: id,
          batchNo: body.batchNo,
          expiryDate: body.expiryDate ?? null,
          quantity: stringifyNumeric(body.quantity),
          supplierName: body.supplierName ?? item[0].supplierName ?? null,
          storageLocation: body.storageLocation ?? item[0].storageLocation ?? null,
          receivedAt: body.receivedAt ? new Date(body.receivedAt) : new Date(),
          isActive: true
        })
        .returning();

      await tx
        .update(inventoryItems)
        .set({ stock: sql`${inventoryItems.stock} + ${body.quantity}`, updatedAt: new Date() })
        .where(eq(inventoryItems.id, id));

      const movementRows = await tx
        .insert(inventoryMovements)
        .values({
          organizationId: actor.organizationId,
          inventoryItemId: id,
          batchId: batchRows[0].id,
          movementType: "in",
          reason: "purchase",
          quantity: stringifyNumeric(body.quantity),
          note: body.note ?? `Batch ${body.batchNo} received`,
          referenceType: "batch",
          referenceId: batchRows[0].id,
          createdById: actor.userId
        })
        .returning();

      const refreshedItem = await tx
        .select(inventoryItemSelect)
        .from(inventoryItems)
        .where(eq(inventoryItems.id, id))
        .limit(1);

      return {
        batch: serializeInventoryBatch(batchRows[0]),
        movement: movementRows[0],
        item: serializeInventoryItem(refreshedItem[0])
      };
    });

    await writeAuditLog(request, {
      entityType: "inventory_batch",
      action: "create",
      entityId: result.batch.id as number
    });

    return reply.code(201).send(result);
  });

  app.get("/:id", { preHandler: app.authorizePermissions(["inventory.read"]) }, async (request) => {
    const actor = request.actor!;
    const { id } = parseOrThrowValidation(idParamSchema, request.params);

    const item = await app.readDb
      .select(inventoryItemSelect)
      .from(inventoryItems)
      .where(and(eq(inventoryItems.id, id), eq(inventoryItems.organizationId, actor.organizationId), isNull(inventoryItems.deletedAt)))
      .limit(1);

    assertOrThrow(item.length === 1, 404, "Inventory item not found");

    const recentMovements = await app.readDb
      .select()
      .from(inventoryMovements)
      .where(and(eq(inventoryMovements.inventoryItemId, id), eq(inventoryMovements.organizationId, actor.organizationId)))
      .orderBy(desc(inventoryMovements.createdAt))
      .limit(10);

    return {
      item: serializeInventoryItem(item[0]),
      movementSummary: {
        recentMovementCount: recentMovements.length,
        lastMovementAt: recentMovements[0]?.createdAt ?? null,
        lastMovementType: recentMovements[0]?.movementType ?? null
      },
      recentMovements
    };
  });

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
        dispenseUnit: payload.dispenseUnit ?? null,
        dispenseUnitSize: payload.dispenseUnitSize?.toString() ?? null,
        purchaseUnit: payload.purchaseUnit ?? null,
        purchaseUnitSize: payload.purchaseUnitSize?.toString() ?? null,
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
    if (body.dispenseUnit !== undefined) patch.dispenseUnit = body.dispenseUnit;
    if (body.dispenseUnitSize !== undefined) patch.dispenseUnitSize = body.dispenseUnitSize?.toString() ?? null;
    if (body.purchaseUnit !== undefined) patch.purchaseUnit = body.purchaseUnit;
    if (body.purchaseUnitSize !== undefined) patch.purchaseUnitSize = body.purchaseUnitSize?.toString() ?? null;
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
        movementUnit: rawBody?.movementUnit,
        batchId: rawBody?.batchId,
        reason: rawBody?.reason,
        note: rawBody?.note,
        referenceType: rawBody?.referenceType,
        referenceId: rawBody?.referenceId
      });

      const movement = await app.db.transaction(async (tx) => {
        const item = await tx
          .select({
            id: inventoryItems.id,
            stock: inventoryItems.stock,
            unit: inventoryItems.unit,
            dispenseUnit: inventoryItems.dispenseUnit,
            dispenseUnitSize: inventoryItems.dispenseUnitSize,
            purchaseUnit: inventoryItems.purchaseUnit,
            purchaseUnitSize: inventoryItems.purchaseUnitSize
          })
          .from(inventoryItems)
          .where(and(eq(inventoryItems.id, id), eq(inventoryItems.organizationId, actor.organizationId)))
          .limit(1);
        assertOrThrow(item.length === 1, 404, "Inventory item not found");
        const baseQuantity = resolveMovementBaseQuantity(item[0], body.quantity, body.movementUnit);
        assertOrThrow(
          Number.isFinite(baseQuantity) && baseQuantity > 0,
          400,
          `Inventory movement unit "${body.movementUnit ?? item[0].unit}" is not configured for this item`
        );

        if (body.batchId) {
          const batch = await tx
            .select(inventoryBatchSelect)
            .from(inventoryBatches)
            .where(
              and(
                eq(inventoryBatches.id, body.batchId),
                eq(inventoryBatches.inventoryItemId, id),
                eq(inventoryBatches.organizationId, actor.organizationId),
                isNull(inventoryBatches.deletedAt)
              )
            )
            .limit(1);
          assertOrThrow(batch.length === 1, 404, "Inventory batch not found");

          const currentBatchQuantity = toNumeric(batch[0].quantity);
          if (body.movementType === "in") {
            await tx
              .update(inventoryBatches)
              .set({ quantity: sql`${inventoryBatches.quantity} + ${baseQuantity}`, updatedAt: new Date() })
              .where(eq(inventoryBatches.id, body.batchId));
          } else {
            assertOrThrow(currentBatchQuantity >= baseQuantity, 409, "Insufficient batch stock");
            await tx
              .update(inventoryBatches)
              .set({ quantity: sql`${inventoryBatches.quantity} - ${baseQuantity}`, updatedAt: new Date() })
              .where(eq(inventoryBatches.id, body.batchId));
          }
        }

        if (body.movementType === "in") {
          await tx
            .update(inventoryItems)
            .set({ stock: sql`${inventoryItems.stock} + ${baseQuantity}`, updatedAt: new Date() })
            .where(eq(inventoryItems.id, id));
        } else {
          const current = Number(item[0].stock);
          assertOrThrow(current >= baseQuantity, 409, "Insufficient stock");
          await tx
            .update(inventoryItems)
            .set({ stock: sql`${inventoryItems.stock} - ${baseQuantity}`, updatedAt: new Date() })
            .where(eq(inventoryItems.id, id));
        }

        const rows = await tx
          .insert(inventoryMovements)
          .values({
            organizationId: actor.organizationId,
            inventoryItemId: id,
            batchId: body.batchId ?? null,
            movementType: body.movementType,
            reason: body.reason ?? defaultMovementReason(body.movementType),
            quantity: stringifyNumeric(baseQuantity),
            note: body.note ?? null,
            referenceType: body.referenceType ?? null,
            referenceId: body.referenceId ?? null,
            createdById: actor.userId
          })
          .returning();

        const refreshedItem = await tx
          .select(inventoryItemSelect)
          .from(inventoryItems)
          .where(eq(inventoryItems.id, id))
          .limit(1);

        return buildMovementResponse(
          rows[0] as Record<string, unknown>,
          refreshedItem[0] as Record<string, unknown>,
          body.quantity,
          body.movementUnit ?? item[0].unit,
          baseQuantity
        );
      });

      await writeAuditLog(request, {
        entityType: "inventory_movement",
        action: "create",
        entityId: Number((movement.movement as Record<string, unknown>).id)
      });
      return reply.code(201).send(movement);
    }
  );

  app.post("/:id/adjust-stock", { preHandler: app.authorizePermissions(["inventory.write"]) }, async (request) => {
    const actor = request.actor!;
    const { id } = parseOrThrowValidation(idParamSchema, request.params);
    const body = parseOrThrowValidation(adjustInventoryStockSchema, request.body);

    const result = await app.db.transaction(async (tx) => {
      const item = await tx
        .select(inventoryItemSelect)
        .from(inventoryItems)
        .where(and(eq(inventoryItems.id, id), eq(inventoryItems.organizationId, actor.organizationId)))
        .limit(1);
      assertOrThrow(item.length === 1, 404, "Inventory item not found");

      const currentStock = Number(item[0].stock);
      const delta = Math.round((body.actualStock - currentStock) * 100) / 100;

      if (delta === 0) {
        return {
          item: serializeInventoryItem(item[0]),
          previousStock: stringifyNumeric(currentStock),
          actualStock: stringifyNumeric(body.actualStock),
          appliedDelta: "0",
          direction: "none",
          movement: null
        };
      }

      const movementType = delta > 0 ? "in" : "out";
      await tx
        .update(inventoryItems)
        .set({ stock: stringifyNumeric(body.actualStock), updatedAt: new Date() })
        .where(eq(inventoryItems.id, id));

      const rows = await tx
        .insert(inventoryMovements)
        .values({
          organizationId: actor.organizationId,
          inventoryItemId: id,
          movementType,
          reason: "adjustment",
          quantity: stringifyNumeric(Math.abs(delta)),
          note: body.note ?? `Adjusted stock from ${currentStock} to ${body.actualStock}`,
          referenceType: "adjustment",
          referenceId: null,
          createdById: actor.userId
        })
        .returning();

      const refreshed = await tx
        .select(inventoryItemSelect)
        .from(inventoryItems)
        .where(eq(inventoryItems.id, id))
        .limit(1);

      return {
        item: serializeInventoryItem(refreshed[0]),
        previousStock: stringifyNumeric(currentStock),
        actualStock: stringifyNumeric(body.actualStock),
        appliedDelta: stringifyNumeric(Math.abs(delta)),
        direction: delta > 0 ? "increase" : "decrease",
        movement: rows[0]
      };
    });

    await writeAuditLog(request, {
      entityType: "inventory_item",
      action: "adjust_stock",
      entityId: id
    });

    return result;
  });

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
