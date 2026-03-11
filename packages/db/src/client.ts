import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export type DbQueryObserver = (query: string) => void;

export const buildDbClient = (
  databaseUrl: string,
  options?: {
    onQuery?: DbQueryObserver;
  }
) => {
  const sql = postgres(databaseUrl, {
    prepare: false,
    max: 20,
    debug(_connection, query) {
      options?.onQuery?.(query);
    }
  });

  return {
    db: drizzle(sql),
    sql
  };
};

export type DbClient = ReturnType<typeof buildDbClient>;
