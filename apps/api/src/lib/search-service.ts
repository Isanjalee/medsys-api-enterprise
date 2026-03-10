import { and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { patients, type buildDbClient } from "@medsys/db";
import type { FastifyBaseLogger } from "fastify";

type DbClient = ReturnType<typeof buildDbClient>["db"];

export type PatientSearchHit = {
  id: number;
  name: string;
  nic: string | null;
  phone: string | null;
  date_of_birth: string | null;
  created_at: string;
  score: number | null;
};

export type PatientSearchResult = {
  patients: PatientSearchHit[];
  total: number;
  page: number;
  limit: number;
};

export type PatientSearchDoc = {
  id: number;
  organizationId: string;
  name: string;
  nic: string | null;
  phone: string | null;
  dateOfBirth: string | null;
  createdAt: string;
};

export type DiagnosisSearchDoc = {
  id: string;
  organizationId: string;
  encounterId: number | null;
  patientId: number | null;
  icd10Code: string | null;
  diagnosisName: string;
  source: "encounter" | "condition";
  createdAt: string;
};

export type SearchService = {
  mode: "opensearch" | "db-fallback";
  searchPatients: (input: { organizationId: string; query: string; page: number; limit: number }) => Promise<PatientSearchResult>;
  upsertPatient: (doc: PatientSearchDoc) => Promise<void>;
  deletePatient: (organizationId: string, patientId: number) => Promise<void>;
  indexDiagnoses: (docs: DiagnosisSearchDoc[]) => Promise<void>;
};

const escapeQuery = (value: string): string => value.replace(/[%_]/g, (match) => `\\${match}`);

const buildSearchDocId = (organizationId: string, entityId: string | number): string =>
  `${organizationId}:${entityId}`;

const toPatientSearchHit = (row: {
  id: number;
  fullName: string | null;
  firstName: string;
  lastName: string;
  nic: string | null;
  phone: string | null;
  dob: string | null;
  createdAt: Date;
}): PatientSearchHit => ({
  id: row.id,
  name: row.fullName ?? `${row.firstName} ${row.lastName}`.trim(),
  nic: row.nic,
  phone: row.phone,
  date_of_birth: row.dob,
  created_at: row.createdAt.toISOString(),
  score: null
});

const createDbFallbackSearchService = (db: DbClient): SearchService => ({
  mode: "db-fallback",
  searchPatients: async ({ organizationId, query, page, limit }) => {
    const pattern = `%${escapeQuery(query.trim())}%`;
    const whereClause = and(
      eq(patients.organizationId, organizationId),
      isNull(patients.deletedAt),
      or(
        ilike(patients.fullName, pattern),
        ilike(patients.nic, pattern),
        ilike(patients.phone, pattern)
      )
    );
    const offset = (page - 1) * limit;

    const [rows, totalRows] = await Promise.all([
      db
        .select({
          id: patients.id,
          fullName: patients.fullName,
          firstName: patients.firstName,
          lastName: patients.lastName,
          nic: patients.nic,
          phone: patients.phone,
          dob: patients.dob,
          createdAt: patients.createdAt
        })
        .from(patients)
        .where(whereClause)
        .orderBy(desc(patients.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ count: sql<number>`count(*)` }).from(patients).where(whereClause)
    ]);

    return {
      patients: rows.map(toPatientSearchHit),
      total: Number(totalRows[0]?.count ?? 0),
      page,
      limit
    };
  },
  upsertPatient: async () => {},
  deletePatient: async () => {},
  indexDiagnoses: async () => {}
});

const createOpenSearchService = (
  db: DbClient,
  logger: FastifyBaseLogger,
  options: { baseUrl: string; patientIndex: string; diagnosisIndex: string }
): SearchService => {
  const dbFallback = createDbFallbackSearchService(db);

  const request = async (path: string, init?: RequestInit): Promise<Response> => {
    const response = await fetch(`${options.baseUrl}${path}`, {
      headers: {
        "content-type": "application/json"
      },
      ...init
    });

    if (!response.ok && response.status !== 400) {
      const body = await response.text();
      throw new Error(`OpenSearch request failed (${response.status}): ${body}`);
    }

    return response;
  };

  const ensureIndex = async (indexName: string, body: unknown): Promise<void> => {
    try {
      await request(`/${indexName}`, {
        method: "PUT",
        body: JSON.stringify(body)
      });
    } catch (error) {
      logger.warn({ err: error, indexName }, "OpenSearch index ensure failed");
    }
  };

  void ensureIndex(options.patientIndex, {
    settings: {
      analysis: {
        normalizer: {
          keyword_lowercase: {
            type: "custom",
            filter: ["lowercase"]
          }
        }
      }
    },
    mappings: {
      properties: {
        organizationId: { type: "keyword" },
        patientId: { type: "long" },
        name: { type: "text" },
        nic: { type: "keyword", normalizer: "keyword_lowercase" },
        phone: { type: "keyword", normalizer: "keyword_lowercase" },
        dateOfBirth: { type: "date", format: "strict_date_optional_time||strict_date" },
        createdAt: { type: "date" }
      }
    }
  });

  void ensureIndex(options.diagnosisIndex, {
    mappings: {
      properties: {
        organizationId: { type: "keyword" },
        encounterId: { type: "long" },
        patientId: { type: "long" },
        icd10Code: { type: "keyword" },
        diagnosisName: { type: "text" },
        source: { type: "keyword" },
        createdAt: { type: "date" }
      }
    }
  });

  return {
    mode: "opensearch",
    searchPatients: async ({ organizationId, query, page, limit }) => {
      try {
        const from = (page - 1) * limit;
        const response = await request(`/${options.patientIndex}/_search`, {
          method: "POST",
          body: JSON.stringify({
            from,
            size: limit,
            track_total_hits: true,
            query: {
              bool: {
                filter: [{ term: { organizationId } }],
                must: [
                  {
                    multi_match: {
                      query,
                      fields: ["name^3", "nic^2", "phone^2"],
                      fuzziness: "AUTO",
                      operator: "and"
                    }
                  }
                ]
              }
            }
          })
        });
        const body = (await response.json()) as {
          hits?: {
            total?: { value?: number };
            hits?: Array<{
              _score?: number;
              _source?: {
                patientId: number;
                name: string;
                nic?: string | null;
                phone?: string | null;
                dateOfBirth?: string | null;
                createdAt: string;
              };
            }>;
          };
        };

        return {
          patients:
            body.hits?.hits?.map((hit) => ({
              id: Number(hit._source?.patientId ?? 0),
              name: hit._source?.name ?? "",
              nic: hit._source?.nic ?? null,
              phone: hit._source?.phone ?? null,
              date_of_birth: hit._source?.dateOfBirth ?? null,
              created_at: hit._source?.createdAt ?? new Date(0).toISOString(),
              score: hit._score ?? null
            })) ?? [],
          total: Number(body.hits?.total?.value ?? 0),
          page,
          limit
        };
      } catch (error) {
        logger.warn({ err: error }, "OpenSearch patient search failed, falling back to DB search");
        return dbFallback.searchPatients({ organizationId, query, page, limit });
      }
    },
    upsertPatient: async (doc) => {
      try {
        await request(`/${options.patientIndex}/_doc/${encodeURIComponent(buildSearchDocId(doc.organizationId, doc.id))}`, {
          method: "PUT",
          body: JSON.stringify({
            organizationId: doc.organizationId,
            patientId: doc.id,
            name: doc.name,
            nic: doc.nic,
            phone: doc.phone,
            dateOfBirth: doc.dateOfBirth,
            createdAt: doc.createdAt
          })
        });
      } catch (error) {
        logger.warn({ err: error, patientId: doc.id }, "OpenSearch patient index sync failed");
      }
    },
    deletePatient: async (organizationId, patientId) => {
      try {
        await request(`/${options.patientIndex}/_doc/${encodeURIComponent(buildSearchDocId(organizationId, patientId))}`, {
          method: "DELETE"
        });
      } catch (error) {
        logger.warn({ err: error, patientId }, "OpenSearch patient delete sync failed");
      }
    },
    indexDiagnoses: async (docs) => {
      if (docs.length === 0) {
        return;
      }

      try {
        const bulkLines = docs.flatMap((doc) => [
          JSON.stringify({ index: { _index: options.diagnosisIndex, _id: buildSearchDocId(doc.organizationId, doc.id) } }),
          JSON.stringify(doc)
        ]);
        await request("/_bulk", {
          method: "POST",
          headers: {
            "content-type": "application/x-ndjson"
          },
          body: `${bulkLines.join("\n")}\n`
        });
      } catch (error) {
        logger.warn({ err: error, count: docs.length }, "OpenSearch diagnosis index sync failed");
      }
    }
  };
};

export const createSearchService = (
  db: DbClient,
  logger: FastifyBaseLogger,
  options: {
    opensearchUrl?: string;
    patientIndex: string;
    diagnosisIndex: string;
  }
): SearchService => {
  if (!options.opensearchUrl) {
    return createDbFallbackSearchService(db);
  }

  return createOpenSearchService(db, logger, {
    baseUrl: options.opensearchUrl.replace(/\/$/, ""),
    patientIndex: options.patientIndex,
    diagnosisIndex: options.diagnosisIndex
  });
};
