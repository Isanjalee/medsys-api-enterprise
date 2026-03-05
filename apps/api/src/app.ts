import Fastify from "fastify";
import environmentPlugin from "./plugins/environment.js";
import databasePlugin from "./plugins/database.js";
import authPlugin from "./plugins/auth.js";
import docsPlugin from "./plugins/docs.js";
import rateLimitPlugin from "./plugins/rate-limit.js";
import auditPublisherPlugin from "./plugins/audit-publisher.js";
import routesPlugin from "./routes/index.js";
import { HttpError } from "./lib/http-error.js";

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
          "req.body.password",
          "res.body.patient.nic",
          "res.body.patient.fullName"
        ],
        censor: "[REDACTED]"
      }
    },
    requestIdHeader: process.env.REQUEST_ID_HEADER ?? "x-request-id"
  });

  await app.register(environmentPlugin);
  await app.register(databasePlugin);
  await app.register(auditPublisherPlugin);
  await app.register(authPlugin);
  await app.register(rateLimitPlugin);
  await app.register(docsPlugin);
  await app.register(routesPlugin, { prefix: "/v1" });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send({ message: error.message, requestId: request.id });
    }
    request.log.error({ err: error }, "Unhandled error");
    return reply.status(500).send({ message: "Internal server error", requestId: request.id });
  });

  app.get("/docs", async (_request, reply) => {
    return reply.redirect("/api/v1/docs");
  });

  app.get("/healthz", async () => ({ ok: true }));

  return app;
};
