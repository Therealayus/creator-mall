import { readSchema, createPgClient } from './sql-client.js'
import type { SqlClient } from './sql-client.js'

export const schemaVersion = 1

/**
 * Applies the schema. Statements are split on `;` at the end of a line, which
 * is enough for a schema we control and avoids a parser dependency.
 */
export async function migrate(client: SqlClient): Promise<{ statements: number }> {
  const sql = await readSchema()
  const statements = sql
    .split('\n')
    .filter((line) => line.trim() && !line.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*\n/)
    .map((statement) => statement.trim())
    .filter(Boolean)

  for (const statement of statements) {
    await client.query(statement)
  }

  // The schema file only creates tables; it never records that they were applied.
  // Without this row `checkSchema` can never be satisfied on a fresh database, so
  // PERSISTENCE=postgres would refuse to boot forever.
  await client.query(
    `INSERT INTO cm_meta (id, schema_version) VALUES (1, ${schemaVersion}) ON CONFLICT (id) DO UPDATE SET schema_version = EXCLUDED.schema_version`,
  )

  return { statements: statements.length }
}

/** True when the control plane tables are present and at the expected version. */
export async function checkSchema(client: SqlClient): Promise<{ ready: boolean; version: number | null; reason: string }> {
  const result = await client.query('SELECT schema_version FROM cm_meta WHERE id = 1')
  if (result.rowCount === 0) {
    return { ready: false, version: null, reason: 'schema has not been applied; run npm run db:migrate' }
  }
  const version = Number(result.rows[0]?.schema_version ?? 0)
  if (version !== schemaVersion) {
    return { ready: false, version, reason: `expected schema version ${schemaVersion}, found ${version}` }
  }
  return { ready: true, version, reason: 'ready' }
}

export { createPgClient }
