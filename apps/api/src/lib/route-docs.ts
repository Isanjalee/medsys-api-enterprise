import type { FastifyInstance, RouteOptions } from "fastify";

type RouteDoc = {
  operationId?: string;
  summary?: string;
  bodySchema?: Record<string, unknown>;
  bodyExample?: unknown;
  bodyExamples?: Record<string, { summary?: string; value: unknown }>;
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

const normalizeRoutePath = (path: string): string => {
  if (!path || path === "") {
    return "/";
  }
  if (path.length > 1 && path.endsWith("/")) {
    return path.slice(0, -1);
  }
  return path;
};

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
    const routePath = normalizeRoutePath(
      typeof routeOptions.routePath === "string" ? routeOptions.routePath : routeOptions.url
    );
    const exact = parsedDocs.find(
      (entry) => entry.method === method && normalizeRoutePath(entry.path) === routePath
    );
    const fallback = parsedDocs
      .filter((entry) => {
        const docPath = normalizeRoutePath(entry.path);
        return entry.method === method && routePath.endsWith(docPath);
      })
      .sort((a, b) => normalizeRoutePath(b.path).length - normalizeRoutePath(a.path).length)[0];
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

    if (schema.body || doc.bodySchema || doc.bodyExample !== undefined || doc.bodyExamples !== undefined) {
      const existingBody =
        schema.body && typeof schema.body === "object" ? { ...(schema.body as Record<string, unknown>) } : undefined;
      const body: Record<string, unknown> = doc.bodySchema
        ? { ...(existingBody ?? {}), ...doc.bodySchema }
        : existingBody ?? {
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

      if (doc.bodyExamples !== undefined) {
        const exampleValues = Object.values(doc.bodyExamples).map((example) => example.value);

        if (body.examples === undefined) {
          body.examples = exampleValues;
        }
        if (body.example === undefined) {
          const firstExample = exampleValues[0];
          if (firstExample) {
            body.example = firstExample;
          }
        }
      }

      nextSchema.body = body;
    }

    routeOptions.schema = nextSchema;
  });
};
