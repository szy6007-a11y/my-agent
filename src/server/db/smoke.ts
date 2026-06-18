import { loadEnvFile } from "@/server/config/load-env-file";
import {
  REQUIRED_DATABASE_INDEXES,
  expectedDatabaseSchema,
} from "@/server/db/schema/inspect";

loadEnvFile();

async function main() {
  const { getSql } = await import("@/lib/db");
  const db = getSql();
  const problems: string[] = [];

  await db`select 1`;

  const migrationRows = await db<{ count: number }[]>`
    select count(*)::int as count
    from drizzle.__drizzle_migrations
  `.catch(() => [{ count: 0 }]);

  if ((migrationRows[0]?.count ?? 0) === 0) {
    problems.push("缺少 Drizzle migration 记录，请先运行 npm run db:migrate");
  }

  const expected = expectedDatabaseSchema();
  const columnRows = await db<{ table_name: string; column_name: string }[]>`
    select table_name, column_name
    from information_schema.columns
    where table_schema = 'public'
  `;

  const actualColumns = new Map<string, Set<string>>();
  for (const row of columnRows) {
    const columns = actualColumns.get(row.table_name) ?? new Set<string>();
    columns.add(row.column_name);
    actualColumns.set(row.table_name, columns);
  }

  for (const [tableName, columns] of expected) {
    const actual = actualColumns.get(tableName);
    if (!actual) {
      problems.push(`缺表: ${tableName}`);
      continue;
    }

    const missingColumns = [...columns].filter((column) => !actual.has(column));
    if (missingColumns.length > 0) {
      problems.push(`表 ${tableName} 缺列: ${missingColumns.join(", ")}`);
    }
  }

  const indexRows = await db<{ indexname: string }[]>`
    select indexname
    from pg_indexes
    where schemaname = 'public'
  `;
  const actualIndexes = new Set(indexRows.map((row) => row.indexname));
  for (const indexName of REQUIRED_DATABASE_INDEXES) {
    if (!actualIndexes.has(indexName)) {
      problems.push(`缺索引: ${indexName}`);
    }
  }

  await db.end();

  if (problems.length > 0) {
    console.error("Database smoke check failed:");
    for (const problem of problems) {
      console.error(`- ${problem}`);
    }
    process.exit(1);
  }

  console.log(
    `Database smoke check passed: ${expected.size} tables, ${REQUIRED_DATABASE_INDEXES.length} indexes.`,
  );
}

main().catch((error) => {
  console.error("Database smoke check failed:", error);
  process.exit(1);
});
