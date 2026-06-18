import { getSql } from "@/lib/db";

let migrationCheckPromise: Promise<void> | null = null;

async function assertMigrationsTableExists() {
  const db = getSql();
  const rows = await db<{ exists: boolean }[]>`
    select exists (
      select 1
      from information_schema.tables
      where table_schema = 'drizzle'
        and table_name = '__drizzle_migrations'
    ) as exists
  `;

  if (!rows[0]?.exists) {
    throw new Error(
      "Database schema has not been migrated. Run `npm run db:migrate` and `npm run db:smoke` before starting the runtime.",
    );
  }
}

export async function assertDatabaseMigrated() {
  migrationCheckPromise ??= assertMigrationsTableExists();
  await migrationCheckPromise;
}
