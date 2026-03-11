import fp from "fastify-plugin";
import * as Sentry from "@sentry/node";
import { HttpError } from "../lib/http-error.js";
import { ObservabilityService } from "../lib/observability-service.js";
import { createSafeErrorLog, createSafeRequestLog, scrubSentryEvent } from "../lib/phi-scrub.js";

const observabilityPlugin = fp(async (app) => {
  const observability = new ObservabilityService();
  app.decorate("observability", observability);

  if (app.env.SENTRY_DSN) {
    Sentry.init({
      dsn: app.env.SENTRY_DSN,
      beforeSend: (event) =>
        scrubSentryEvent(event as unknown as Record<string, unknown>) as unknown as typeof event
    });
  }

  app.addHook("onRequest", (request, _reply, done) => {
    observability.runWithRequestContext(request, () => {
      request.traceId = observability.getCurrentTraceId() ?? undefined;
      done();
    });
  });

  app.addHook("onResponse", (request, reply, done) => {
    observability.finalizeRequest(request, reply.statusCode);
    request.log.info(
      {
        request: createSafeRequestLog(request),
        traceId: request.traceId,
        statusCode: reply.statusCode
      },
      "Request completed"
    );
    done();
  });

  app.addHook("onError", (request, reply, error, done) => {
    request.log.error(
      {
        request: createSafeRequestLog(request),
        traceId: request.traceId,
        error: createSafeErrorLog(error)
      },
      "Request failed"
    );

    const statusCode = error instanceof HttpError ? error.statusCode : reply.statusCode;
    if (statusCode >= 500 && app.env.SENTRY_DSN) {
      Sentry.captureException(error, {
        extra: {
          request: createSafeRequestLog(request),
          traceId: request.traceId
        }
      });
    }
    done();
  });

  app.addHook("onClose", async () => {
    if (app.env.SENTRY_DSN) {
      await Sentry.close(2000);
    }
  });
});

export default observabilityPlugin;
