import type { FastifyInstance, RouteOptions } from "fastify";

type RouteDoc = {
  operationId?: string;
  summary?: string;
  bodySchema?: Record<string, unknown>;
  bodyExample?: unknown;
  security?: unknown[];
};

type RouteDocMap = Record<string, RouteDoc>;

type ParsedRouteDoc = {
  method: string;
  path: string;
  doc: RouteDoc;
};

const methodFromRoute = (method: RouteOptions["method"]): string =>
  (Array.isArray(method) ? method[0] : method).toUpperCase();

const buildDefaultOperationId = (controller: string, method: string, url: string): string => {
  const cleanPath = url
    .replace(/^\//, "")
    .replace(/[:/{}-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/_$/, "");

  const suffix = cleanPath.length > 0 ? `_${cleanPath}` : "";
  return `${controller}_${method.toLowerCase()}${suffix}`;
};

export const applyRouteDocs = (
  app: FastifyInstance,
  tag: string,
  controller: string,
  docs: RouteDocMap
): void => {
  const parsedDocs: ParsedRouteDoc[] = Object.entries(docs).map(([key, doc]) => {
    const firstSpace = key.indexOf(" ");
    const method = key.slice(0, firstSpace).toUpperCase();
    const path = key.slice(firstSpace + 1);
    return { method, path, doc };
  });

  app.addHook("onRoute", (routeOptions) => {
    const method = methodFromRoute(routeOptions.method);
    const routePath = routeOptions.url;
    const exact = parsedDocs.find((entry) => entry.method === method && entry.path === routePath);
    const fallback = parsedDocs
      .filter((entry) => entry.method === method && routePath.endsWith(entry.path))
      .sort((a, b) => b.path.length - a.path.length)[0];
    const doc = exact?.doc ?? fallback?.doc ?? {};
    const schema = (routeOptions.schema ?? {}) as Record<string, unknown>;

    const nextSchema: Record<string, unknown> = {
      ...schema,
      tags: schema.tags ?? [tag],
      operationId:
        schema.operationId ??
        doc.operationId ??
        buildDefaultOperationId(controller, method, routeOptions.url),
      summary: schema.summary ?? doc.summary,
      security: schema.security ?? doc.security
    };

    if (!schema.body && (doc.bodySchema || doc.bodyExample !== undefined)) {
      const body: Record<string, unknown> = doc.bodySchema
        ? { ...doc.bodySchema }
        : {
            type: "object",
            additionalProperties: true
          };

      if (doc.bodyExample !== undefined) {
        if (body.example === undefined) {
          body.example = doc.bodyExample;
        }
        if (body.examples === undefined) {
          body.examples = [doc.bodyExample];
        }
      }

      nextSchema.body = body;
    }

    routeOptions.schema = nextSchema;
  });
};
