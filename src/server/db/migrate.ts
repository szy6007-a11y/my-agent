import { resolve } from "path";

import { loadEnvFile } from "@/server/config/load-env-file";

loadEnvFile();

async function main() {
  const [{ drizzle }, { migrate }, { getSql }, { serverEnv }] = await Promise.all([
    import("drizzle-orm/postgres-js"),
    import("drizzle-orm/postgres-js/migrator"),
    import("@/lib/db"),
    import("@/lib/env"),
  ]);
  const sql = getSql();

  await sql`select 1`;
  await sql`select set_config('my_agent.app_env', ${serverEnv.APP_ENV}, false)`;

  const db = drizzle(sql);
  const migrationsFolder = resolve(process.cwd(), "drizzle");

  await migrate(db, { migrationsFolder });

  await sql.end();
  console.log(`Database migrations applied for ${serverEnv.APP_ENV}.`);
}

main().catch((error) => {
  console.error("Database migration failed:", error);
  process.exit(1);
});
