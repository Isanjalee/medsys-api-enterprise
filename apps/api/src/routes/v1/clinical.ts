import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { clinicalCodeParamSchema, clinicalIcd10QuerySchema, clinicalTerminologyQuerySchema } from "@medsys/validation";
import { getRecommendedTestsForDiagnosis, searchFallbackDiagnoses } from "../../lib/clinical-terminology.js";
import { applyRouteDocs } from "../../lib/route-docs.js";
import { HttpError, parseOrThrowValidation } from "../../lib/http-error.js";

type ClinicalTablesResponse = [
  number,
  string[],
  Record<string, unknown> | null,
  string[][],
  string[]?
];

type TerminologyItem = {
  code: string;
  codeSystem: string;
  display: string;
};

type TestTerminologyItem = TerminologyItem & {
  category: string | null;
};

const blockedLoincDisplayPatterns = [
  /\bnote\b/i,
  /\bnotes\b/i,
  /\bquestionnaire\b/i,
  /\bquestion\b/i,
  /\bsurvey\b/i,
  /\bset\b/i,
  /\bassessment\b/i,
  /\bhistory\b/i,
  /\bever told\b/i,
  /\breported\b/i,
  /\bscreening form\b/i,
  /\bpanel\.? set\b/i
];

const isLikelyOrderableClinicalTest = (item: TestTerminologyItem): boolean => {
  const display = item.display.trim();
  if (!display) {
    return false;
  }

  if (blockedLoincDisplayPatterns.some((pattern) => pattern.test(display))) {
    return false;
  }

  return true;
};

const normalizeAndFilterLoincPayload = (payload: unknown, limit: number): TestTerminologyItem[] => {
  const seen = new Set<string>();

  return normalizeLoincPayload(payload)
    .filter(isLikelyOrderableClinicalTest)
    .filter((item) => {
      const key = `${item.code}|${item.display}`.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, limit);
};

const normalizeIcd10Payload = (payload: unknown): TerminologyItem[] => {
  if (!Array.isArray(payload) || !Array.isArray(payload[3])) {
    throw new HttpError(502, "Invalid ICD10 provider response");
  }

  return (payload as ClinicalTablesResponse)[3]
    .filter((row): row is string[] => Array.isArray(row))
    .map((row) => {
      const code = typeof row[0] === "string" ? row[0].trim() : "";
      const display = typeof row[1] === "string" ? row[1].trim() : "";
      return {
        code,
        display,
        codeSystem: "ICD-10-CM"
      };
    })
    .filter((item) => item.code.length > 0 && item.display.length > 0);
};

const normalizeLoincPayload = (payload: unknown): TestTerminologyItem[] => {
  if (!Array.isArray(payload) || !Array.isArray(payload[3])) {
    if (!(payload && typeof payload === "object" && Array.isArray((payload as { expansion?: { contains?: unknown[] } }).expansion?.contains)) &&
        !(payload && typeof payload === "object" && Array.isArray((payload as { items?: unknown[] }).items))) {
      throw new HttpError(502, "Invalid LOINC provider response");
    }
  }

  if (Array.isArray(payload) && Array.isArray(payload[3])) {
    return (payload as ClinicalTablesResponse)[3]
      .filter((row): row is string[] => Array.isArray(row))
      .map((row) => {
        const code = typeof row[0] === "string" ? row[0].trim() : "";
        const display = typeof row[1] === "string" ? row[1].trim() : "";
        return {
          code,
          display,
          codeSystem: "LOINC",
          category: null
        };
      })
      .filter((item) => item.code.length > 0 && item.display.length > 0);
  }

  if (payload && typeof payload === "object" && Array.isArray((payload as { expansion?: { contains?: unknown[] } }).expansion?.contains)) {
    return ((payload as { expansion: { contains: unknown[] } }).expansion.contains ?? [])
      .flatMap((row) => {
        if (!row || typeof row !== "object") {
          return [];
        }

        const code = typeof (row as { code?: unknown }).code === "string" ? (row as { code: string }).code.trim() : "";
        const display =
          typeof (row as { display?: unknown }).display === "string"
            ? (row as { display: string }).display.trim()
            : "";
        const category =
          typeof (row as { designation?: unknown[] }).designation?.[0] === "object" &&
          typeof ((row as { designation: Array<{ value?: unknown }> }).designation[0]?.value) === "string"
            ? ((row as { designation: Array<{ value: string }> }).designation[0]?.value ?? "").trim()
            : null;

        return code && display
          ? [
              {
                code,
                display,
                codeSystem: "LOINC",
                category
              }
            ]
          : [];
      });
  }

  if (payload && typeof payload === "object" && Array.isArray((payload as { items?: unknown[] }).items)) {
    return ((payload as { items: unknown[] }).items ?? [])
      .flatMap((row) => {
        if (!row || typeof row !== "object") {
          return [];
        }
        const code = typeof (row as { code?: unknown }).code === "string" ? (row as { code: string }).code.trim() : "";
        const display =
          typeof (row as { display?: unknown; testName?: unknown }).display === "string"
            ? (row as { display: string }).display.trim()
            : typeof (row as { testName?: unknown }).testName === "string"
              ? (row as { testName: string }).testName.trim()
              : "";
        const category =
          typeof (row as { category?: unknown }).category === "string"
            ? (row as { category: string }).category.trim()
            : null;
        return code && display
          ? [
              {
                code,
                display,
                codeSystem: "LOINC",
                category
              }
            ]
          : [];
      });
  }

  throw new HttpError(502, "Invalid LOINC provider response");
};

const fetchJson = async (
  request: FastifyRequest,
  url: URL,
  providerName: "ICD10" | "LOINC"
): Promise<unknown> => {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        accept: "application/json"
      }
    });
  } catch (error) {
    request.log.error({ err: error, providerName }, `${providerName} provider request failed`);
    throw new HttpError(503, `${providerName} provider unavailable`);
  }

  if (!response.ok) {
    request.log.error({ providerName, status: response.status }, `${providerName} provider returned non-success status`);
    throw new HttpError(503, `${providerName} provider unavailable`);
  }

  try {
    return await response.json();
  } catch (error) {
    request.log.error({ err: error, providerName }, `${providerName} provider returned invalid JSON`);
    throw new HttpError(502, `Invalid ${providerName} provider response`);
  }
};

const isProviderUnavailableError = (error: unknown): error is HttpError =>
  error instanceof HttpError && error.statusCode === 503;

const clinicalRoutes: FastifyPluginAsync = async (app) => {
  const terminologyQuerySchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      terms: { type: "string", minLength: 0 },
      limit: { type: "integer", minimum: 1, maximum: 50, nullable: true }
    }
  } as const;

  const messageErrorResponseSchema = {
    type: "object",
    additionalProperties: false,
    required: ["message"],
    properties: {
      message: { type: "string" }
    }
  } as const;

  applyRouteDocs(app, "Clinical", "ClinicalController", {
    "GET /icd10": {
      operationId: "ClinicalController_icd10",
      summary: "Search ICD-10 diagnosis suggestions"
    },
    "GET /diagnoses": {
      operationId: "ClinicalController_diagnoses",
      summary: "Search normalized diagnosis terminology suggestions"
    },
    "GET /tests": {
      operationId: "ClinicalController_tests",
      summary: "Search normalized clinical test terminology suggestions"
    },
    "GET /diagnoses/:code/recommended-tests": {
      operationId: "ClinicalController_recommendedTests",
      summary: "Get curated recommended tests for a diagnosis code"
    }
  });

  app.addHook("preHandler", app.authenticate);

  app.get(
    "/icd10",
    {
      preHandler: app.authorizePermissions(["clinical.icd10.read"]),
      schema: {
        tags: ["Clinical"],
        operationId: "ClinicalController_icd10",
        summary: "Search ICD-10 diagnosis suggestions"
      }
    },
    async (request) => {
      const query = parseOrThrowValidation(clinicalIcd10QuerySchema, request.query ?? {});
      const terms = query.terms ?? "";
      if (terms.length < 2) {
        return { suggestions: [] };
      }

      const url = new URL(app.env.ICD10_API_BASE_URL);
      url.searchParams.set("sf", "code,name");
      url.searchParams.set("df", "code,name");
      url.searchParams.set("terms", terms);
      url.searchParams.set("count", "10");

      let suggestions: string[];
      try {
        const payload = await fetchJson(request, url, "ICD10");
        suggestions = normalizeIcd10Payload(payload).map((item) => `${item.code} - ${item.display}`);
      } catch (error) {
        if (!isProviderUnavailableError(error)) {
          throw error;
        }

        request.log.warn({ providerName: "ICD10", terms }, "Falling back to curated ICD10 suggestions");
        suggestions = searchFallbackDiagnoses(terms, 10).map((item) => `${item.code} - ${item.display}`);
      }
      return { suggestions };
    }
  );

  app.get(
    "/diagnoses",
    {
      preHandler: app.authorizePermissions(["clinical.icd10.read"]),
      schema: {
        tags: ["Clinical"],
        operationId: "ClinicalController_diagnoses",
        summary: "Search normalized diagnosis terminology suggestions",
        querystring: terminologyQuerySchema,
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["diagnoses"],
            properties: {
              diagnoses: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["code", "codeSystem", "display"],
                  properties: {
                    code: { type: "string" },
                    codeSystem: { type: "string", example: "ICD-10-CM" },
                    display: { type: "string" }
                  }
                }
              }
            },
            example: {
              diagnoses: [
                {
                  code: "I11.9",
                  codeSystem: "ICD-10-CM",
                  display: "Hypertensive heart disease without heart failure"
                }
              ]
            }
          },
          400: {
            ...messageErrorResponseSchema,
            example: { message: "Diagnosis search input is invalid." }
          },
          503: {
            ...messageErrorResponseSchema,
            example: { message: "ICD10 provider unavailable" }
          }
        }
      }
    },
    async (request) => {
      const query = parseOrThrowValidation(clinicalTerminologyQuerySchema, request.query ?? {});
      const terms = query.terms ?? "";
      const limit = query.limit ?? 10;
      if (terms.length < 2) {
        return { diagnoses: [] };
      }

      const url = new URL(app.env.ICD10_API_BASE_URL);
      url.searchParams.set("sf", "code,name");
      url.searchParams.set("df", "code,name");
      url.searchParams.set("terms", terms);
      url.searchParams.set("count", String(limit));

      try {
        const payload = await fetchJson(request, url, "ICD10");
        return {
          diagnoses: normalizeIcd10Payload(payload)
        };
      } catch (error) {
        if (!isProviderUnavailableError(error)) {
          throw error;
        }

        request.log.warn({ providerName: "ICD10", terms, limit: query.limit }, "Falling back to curated ICD10 diagnoses");
        return {
          diagnoses: searchFallbackDiagnoses(terms, limit)
        };
      }
    }
  );

  app.get(
    "/tests",
    {
      preHandler: app.authorizePermissions(["clinical.icd10.read"]),
      schema: {
        tags: ["Clinical"],
        operationId: "ClinicalController_tests",
        summary: "Search normalized clinical test terminology suggestions",
        querystring: terminologyQuerySchema,
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["tests"],
            properties: {
              tests: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["code", "codeSystem", "display", "category"],
                  properties: {
                    code: { type: "string" },
                    codeSystem: { type: "string", example: "LOINC" },
                    display: { type: "string" },
                    category: { type: "string", nullable: true }
                  }
                }
              }
            },
            example: {
              tests: [
                {
                  code: "3016-3",
                  codeSystem: "LOINC",
                  display: "Thyrotropin (TSH) [Units/volume] in Serum or Plasma",
                  category: null
                }
              ]
            }
          },
          400: {
            ...messageErrorResponseSchema,
            example: { message: "Test search input is invalid." }
          },
          503: {
            ...messageErrorResponseSchema,
            example: { message: "LOINC provider unavailable" }
          }
        }
      }
    },
    async (request) => {
      const query = parseOrThrowValidation(clinicalTerminologyQuerySchema, request.query ?? {});
      const terms = query.terms ?? "";
      const limit = query.limit ?? 10;
      if (terms.length < 2) {
        return { tests: [] };
      }

      const url = new URL(app.env.LOINC_API_BASE_URL);
      const lowerBaseUrl = app.env.LOINC_API_BASE_URL.toLowerCase();
      if (lowerBaseUrl.includes("clinicaltables.nlm.nih.gov")) {
        url.searchParams.set("terms", terms);
        url.searchParams.set("count", String(limit));
        url.searchParams.set("df", "LOINC_NUM,LONG_COMMON_NAME");
      } else {
        url.searchParams.set("filter", terms);
        url.searchParams.set("count", String(limit));
      }

      const payload = await fetchJson(request, url, "LOINC");
      return {
        tests: normalizeAndFilterLoincPayload(payload, limit)
      };
    }
  );

  app.get(
    "/diagnoses/:code/recommended-tests",
    {
      preHandler: app.authorizePermissions(["clinical.icd10.read"]),
      schema: {
        tags: ["Clinical"],
        operationId: "ClinicalController_recommendedTests",
        summary: "Get curated recommended tests for a diagnosis code",
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["diagnosis", "source", "tests"],
            properties: {
              diagnosis: {
                type: "object",
                additionalProperties: false,
                required: ["code", "codeSystem"],
                properties: {
                  code: { type: "string" },
                  codeSystem: { type: "string" }
                }
              },
              source: { type: "string", example: "curated" },
              tests: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["code", "codeSystem", "display", "category"],
                  properties: {
                    code: { type: "string" },
                    codeSystem: { type: "string" },
                    display: { type: "string" },
                    category: { type: "string", nullable: true }
                  }
                }
              }
            },
            example: {
              diagnosis: {
                code: "E11.9",
                codeSystem: "ICD-10-CM"
              },
              source: "curated",
              tests: [
                {
                  code: "4548-4",
                  codeSystem: "LOINC",
                  display: "Hemoglobin A1c/Hemoglobin.total in Blood",
                  category: "laboratory"
                }
              ]
            }
          },
          400: {
            ...messageErrorResponseSchema,
            example: { message: "We couldn’t load suggested tests for this diagnosis." }
          }
        }
      }
    },
    async (request) => {
      const params = parseOrThrowValidation(clinicalCodeParamSchema, request.params);
      return {
        diagnosis: {
          code: params.code,
          codeSystem: "ICD-10-CM"
        },
        source: "curated",
        tests: getRecommendedTestsForDiagnosis(params.code)
      };
    }
  );
};

export default clinicalRoutes;
