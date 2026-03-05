import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export const buildDbClient = (databaseUrl: string) => {
  const sql = postgres(databaseUrl, {
    prepare: false,
    max: 20
  });

  return {
    db: drizzle(sql),
    sql
  };
};

export type DbClient = ReturnType<typeof buildDbClient>;
