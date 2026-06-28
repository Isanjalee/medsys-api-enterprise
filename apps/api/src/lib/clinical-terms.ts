import { sql } from "drizzle-orm";
import { clinicalTerms } from "@medsys/db";
import type { FastifyInstance } from "fastify";

export type ClinicalTermType = "diagnosis" | "test" | "drug";

/**
 * Upsert the names a doctor typed into their personal clinical-term dictionary.
 * Used to build local autocomplete suggestions in place of the old external APIs.
 * Never throws — dictionary capture must never break the clinical save it follows.
 */
export const recordClinicalTerms = async (
  app: FastifyInstance,
  input: {
    organizationId: string;
    doctorUserId: number;
    termType: ClinicalTermType;
    names: Array<string | null | undefined>;
  }
): Promise<void> => {
  const cleaned = Array.from(
    new Set(
      input.names
        .map((name) => (typeof name === "string" ? name.trim() : ""))
        .filter((name) => name.length > 0 && name.length <= 255)
    )
  );
  if (cleaned.length === 0) {
    return;
  }

  try {
    await app.db
      .insert(clinicalTerms)
      .values(
        cleaned.map((name) => ({
          organizationId: input.organizationId,
          doctorUserId: input.doctorUserId,
          termType: input.termType,
          name
        }))
      )
      .onConflictDoUpdate({
        target: [
          clinicalTerms.organizationId,
          clinicalTerms.doctorUserId,
          clinicalTerms.termType,
          clinicalTerms.name
        ],
        set: {
          usageCount: sql`${clinicalTerms.usageCount} + 1`,
          lastUsedAt: new Date(),
          updatedAt: new Date()
        }
      });
  } catch (error) {
    app.log.warn({ err: error }, "Failed to record clinical terms");
  }
};
