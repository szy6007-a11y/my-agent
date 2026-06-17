import postgres, { type Sql } from "postgres";

import { serverEnv } from "@/lib/env";

let sql: Sql | null = null;

export function getSql() {
  if (!serverEnv.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for agent persistence");
  }

  sql ??= postgres(serverEnv.DATABASE_URL, {
    max: 5,
    onnotice: () => undefined,
  });

  return sql;
}
