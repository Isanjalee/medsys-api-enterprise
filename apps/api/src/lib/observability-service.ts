import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { context, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import type { FastifyRequest } from "fastify";

type RequestMetricKey = `${string}:${string}`;

type RequestMetric = {
  count: number;
  errors: number;
  totalDurationMs: number;
};

type TraceSnapshot = {
  requestId: string;
  traceId: string;
  route: string;
  method: string;
  statusCode: number;
  durationMs: number;
  dbQueryCount: number;
  dbTargets: string[];
  actorRole: string | null;
};

type RequestContext = {
  requestId: string;
  method: string;
  route: string;
  startedAt: number;
  span: Span;
  traceId: string;
  dbQueryCount: number;
  dbTargets: Set<string>;
};

export class ObservabilityService {
  private readonly tracer = trace.getTracer("medsys-api");
  private readonly asyncLocal = new AsyncLocalStorage<RequestContext>();
  private readonly requestMetrics = new Map<RequestMetricKey, RequestMetric>();
  private readonly recentTraces: TraceSnapshot[] = [];
  private readonly serviceStartedAt = Date.now();
  private errorCount = 0;

  runWithRequestContext<T>(request: FastifyRequest, callback: () => T): T {
    const route = request.routeOptions.url ?? request.url;
    const span = this.tracer.startSpan(`${request.method} ${route}`, {
      attributes: {
        "http.method": request.method,
        "http.route": route,
        "http.request_id": request.id
      }
    });
    const spanContext = span.spanContext();
    const store: RequestContext = {
      requestId: request.id,
      method: request.method,
      route,
      startedAt: performance.now(),
      span,
      traceId: spanContext.traceId,
      dbQueryCount: 0,
      dbTargets: new Set<string>()
    };

    return this.asyncLocal.run(store, callback);
  }

  getCurrentTraceId(): string | null {
    return this.asyncLocal.getStore()?.traceId ?? null;
  }

  recordDbQuery(target: "primary" | "read" | "analytics", query: string): void {
    const store = this.asyncLocal.getStore();
    if (!store) {
      return;
    }

    store.dbQueryCount += 1;
    store.dbTargets.add(target);

    const parentContext = trace.setSpan(context.active(), store.span);
    const span = this.tracer.startSpan(
      `db.${target}.${query.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "query"}`,
      {
        attributes: {
          "db.system": "postgresql",
          "db.operation": query.trim().split(/\s+/, 1)[0]?.toUpperCase() ?? "QUERY",
          "db.target": target
        }
      },
      parentContext
    );
    span.end();
  }

  finalizeRequest(request: FastifyRequest, statusCode: number): void {
    const store = this.asyncLocal.getStore();
    if (!store) {
      return;
    }

    const durationMs = performance.now() - store.startedAt;
    const metricKey: RequestMetricKey = `${store.method}:${store.route}`;
    const metric = this.requestMetrics.get(metricKey) ?? {
      count: 0,
      errors: 0,
      totalDurationMs: 0
    };

    metric.count += 1;
    metric.totalDurationMs += durationMs;
    if (statusCode >= 400) {
      metric.errors += 1;
    }

    this.requestMetrics.set(metricKey, metric);

    store.span.setAttribute("http.status_code", statusCode);
    store.span.setAttribute("medsys.db_query_count", store.dbQueryCount);
    store.span.setAttribute("medsys.request_id", store.requestId);

    if (statusCode >= 500) {
      this.errorCount += 1;
      store.span.setStatus({ code: SpanStatusCode.ERROR });
    }

    store.span.end();

    this.recentTraces.unshift({
      requestId: store.requestId,
      traceId: store.traceId,
      route: store.route,
      method: store.method,
      statusCode,
      durationMs: Number(durationMs.toFixed(2)),
      dbQueryCount: store.dbQueryCount,
      dbTargets: [...store.dbTargets],
      actorRole: request.actor?.role ?? null
    });
    this.recentTraces.splice(25);
  }

  getMetrics() {
    const uptimeMinutes = Math.max(1 / 60, (Date.now() - this.serviceStartedAt) / 60000);
    return {
      routes: [...this.requestMetrics.entries()].map(([key, value]) => {
        const [method, route] = key.split(":");
        return {
          method,
          route,
          count: value.count,
          errors: value.errors,
          averageDurationMs: Number((value.totalDurationMs / value.count).toFixed(2)),
          requestsPerMinute: Number((value.count / uptimeMinutes).toFixed(2))
        };
      }),
      totals: {
        requests: [...this.requestMetrics.values()].reduce((sum, entry) => sum + entry.count, 0),
        errors: this.errorCount
      },
      recentTraces: [...this.recentTraces]
    };
  }

  renderPrometheusMetrics(): string {
    const lines = [
      "# HELP medsys_http_requests_total Total HTTP requests by route",
      "# TYPE medsys_http_requests_total counter"
    ];

    for (const [key, value] of this.requestMetrics.entries()) {
      const [method, route] = key.split(":");
      const safeRoute = route.replace(/"/g, '\\"');
      lines.push(`medsys_http_requests_total{method="${method}",route="${safeRoute}"} ${value.count}`);
    }

    lines.push("# HELP medsys_http_errors_total Total HTTP 4xx/5xx responses by route");
    lines.push("# TYPE medsys_http_errors_total counter");
    for (const [key, value] of this.requestMetrics.entries()) {
      const [method, route] = key.split(":");
      const safeRoute = route.replace(/"/g, '\\"');
      lines.push(`medsys_http_errors_total{method="${method}",route="${safeRoute}"} ${value.errors}`);
    }

    lines.push("# HELP medsys_http_request_duration_ms_avg Average request duration in milliseconds by route");
    lines.push("# TYPE medsys_http_request_duration_ms_avg gauge");
    for (const [key, value] of this.requestMetrics.entries()) {
      const [method, route] = key.split(":");
      const safeRoute = route.replace(/"/g, '\\"');
      const average = value.count === 0 ? 0 : value.totalDurationMs / value.count;
      lines.push(
        `medsys_http_request_duration_ms_avg{method="${method}",route="${safeRoute}"} ${average.toFixed(2)}`
      );
    }

    return `${lines.join("\n")}\n`;
  }
}
