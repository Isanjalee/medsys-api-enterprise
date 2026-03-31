import Fastify from "fastify";
import environmentPlugin from "./plugins/environment.js";
import observabilityPlugin from "./plugins/observability.js";
import databasePlugin from "./plugins/database.js";
import securityPlugin from "./plugins/security.js";
import authPlugin from "./plugins/auth.js";
import docsPlugin from "./plugins/docs.js";
import rateLimitPlugin from "./plugins/rate-limit.js";
import auditPublisherPlugin from "./plugins/audit-publisher.js";
import cachePlugin from "./plugins/cache.js";
import searchPlugin from "./plugins/search.js";
import routesPlugin from "./routes/index.js";
import { ZodError } from "zod";
import { HttpError, ValidationError, validationIssuesFromZodError } from "./lib/http-error.js";
import { createSafeErrorLog, createSafeRequestLog, scrubPhi } from "./lib/phi-scrub.js";

const buildValidationErrorEnvelope = (
  requestId: string,
  issues: Array<{ field: string; message: string }>
) => ({
  error: "Validation failed.",
  code: "VALIDATION_ERROR",
  severity: "warning" as const,
  userMessage: "Please check the highlighted fields and try again.",
  requestId,
  statusCode: 400,
  issues
});

export const buildApp = async () => {
  const app = Fastify({
    ajv: {
      customOptions: {
        strict: false
      }
    },
    logger: {
      level: process.env.NODE_ENV === "production" ? "info" : "debug",
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.body.password",
          "req.body.refreshToken",
          "req.body.accessToken",
          "req.body.nic",
          "req.body.guardianNic",
          "req.body.phone",
          "req.body.guardianPhone",
          "req.body.address",
          "req.body.name",
          "req.body.patientDraft.nic",
          "req.body.patientDraft.guardianNic",
          "req.body.patientDraft.phone",
          "req.body.patientDraft.mobile",
          "req.body.patientDraft.guardianPhone",
          "req.body.patientDraft.address",
          "req.body.patientDraft.name",
          "res.body.patient.nic",
          "res.body.patient.guardianNic",
          "res.body.patient.fullName",
          "res.body.patient.phone",
          "res.body.patient.guardianPhone",
          "res.body.patient.address",
          "res.body.user.email"
        ],
        censor: "[REDACTED]"
      },
      serializers: {
        req(request) {
          return createSafeRequestLog({
            id: request.id,
            method: request.method,
            url: request.url,
            ip: request.ip,
            query: request.query,
            body: request.body
          });
        },
        err(error) {
          return createSafeErrorLog(error);
        }
      }
    },
    requestIdHeader: process.env.REQUEST_ID_HEADER ?? "x-request-id"
  });

  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    /^application\/json(?:\s*;.*)?$/i,
    { parseAs: "string" },
    (_request, body, done) => {
      const rawBody = typeof body === "string" ? body : body.toString("utf8");

      if (rawBody.trim() === "") {
        done(null, {});
        return;
      }

      try {
        done(null, JSON.parse(rawBody));
      } catch {
        const error = new Error("Body cannot be parsed as JSON") as Error & {
          code?: string;
          statusCode?: number;
        };
        error.code = "FST_ERR_CTP_INVALID_JSON_BODY";
        error.statusCode = 400;
        done(error, undefined);
      }
    }
  );

  await app.register(environmentPlugin);
  await app.register(observabilityPlugin);
  await app.register(databasePlugin);
  await app.register(securityPlugin);
  await app.register(auditPublisherPlugin);
  await app.register(cachePlugin);
  await app.register(searchPlugin);
  await app.register(authPlugin);
  await app.register(rateLimitPlugin);
  await app.register(docsPlugin);
  await app.register(routesPlugin, { prefix: "/v1" });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ValidationError) {
      return reply.status(400).send(buildValidationErrorEnvelope(request.id, error.issues));
    }
    if (error instanceof ZodError) {
      return reply.status(400).send(buildValidationErrorEnvelope(request.id, validationIssuesFromZodError(error)));
    }
    if ((error as { code?: string }).code === "FST_ERR_CTP_INVALID_JSON_BODY") {
      return reply
        .status(400)
        .send(buildValidationErrorEnvelope(request.id, [{ field: "body", message: "Must be valid JSON." }]));
    }
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send({
        message: error.message,
        code: error.code,
        severity: error.severity,
        userMessage: error.userMessage,
        requestId: request.id,
        statusCode: error.statusCode
      });
    }
    request.log.error(
      {
        request: createSafeRequestLog(request),
        traceId: request.traceId,
        error: createSafeErrorLog(error)
      },
      "Unhandled error"
    );
    return reply.status(500).send({
      message: "Internal server error",
      code: "INTERNAL_SERVER_ERROR",
      severity: "error",
      userMessage: "Something went wrong. Please try again.",
      requestId: request.id,
      statusCode: 500
    });
  });

  app.get("/docs", async (_request, reply) => {
    return reply.redirect("/api/v1/docs");
  });

  app.get("/healthz", async () => ({ ok: true }));

  app.get("/metrics", async (_request, reply) => {
    return reply.type("text/plain; version=0.0.4").send(app.observability.renderPrometheusMetrics());
  });

  app.get("/security/phi-check", async () => ({
    scrubbedExample: scrubPhi({
      patient: {
        name: "Jane Doe",
        nic: "991234567V",
        phone: "+94770000000",
        address: "42 Main Street"
      },
      password: "secret"
    })
  }));

  return app;
};
