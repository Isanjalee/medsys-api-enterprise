import fp from "fastify-plugin";
import { buildDbClient } from "@medsys/db";

const databasePlugin = fp(async (app) => {
  const writer = buildDbClient(app.env.DATABASE_URL, {
    onQuery: (query) => app.observability.recordDbQuery("primary", query)
  });
  const reader = buildDbClient(app.env.DATABASE_READ_URL ?? app.env.DATABASE_URL, {
    onQuery: (query) =>
      app.observability.recordDbQuery(
        app.env.DATABASE_READ_URL && app.env.DATABASE_READ_URL !== app.env.DATABASE_URL
          ? "analytics"
          : "read",
        query
      )
  });
  const analyticsUsesReplica =
    Boolean(app.env.DATABASE_READ_URL) && app.env.DATABASE_READ_URL !== app.env.DATABASE_URL;

  app.decorate("db", writer.db);
  app.decorate("readDb", writer.db);
  app.decorate("analyticsDb", reader.db);

  app.log.info(
    { analyticsUsesReplica },
    analyticsUsesReplica
      ? "Analytics/reporting reads are routed to DATABASE_READ_URL; writes and operational reads stay on the primary database"
      : "DATABASE_READ_URL not configured; analytics/reporting reads are currently using the primary database"
  );

  app.addHook("onClose", async () => {
    await writer.sql.end({ timeout: 5 });
    if (reader.sql !== writer.sql) {
      await reader.sql.end({ timeout: 5 });
    }
  });
});

export default databasePlugin;
