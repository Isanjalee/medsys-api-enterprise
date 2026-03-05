import fp from "fastify-plugin";
import { buildDbClient } from "@medsys/db";

const databasePlugin = fp(async (app) => {
  const writer = buildDbClient(app.env.DATABASE_URL);
  const reader = buildDbClient(app.env.DATABASE_READ_URL ?? app.env.DATABASE_URL);

  app.decorate("db", writer.db);
  app.decorate("readDb", reader.db);

  app.addHook("onClose", async () => {
    await writer.sql.end({ timeout: 5 });
    await reader.sql.end({ timeout: 5 });
  });
});

export default databasePlugin;
