import { checkSchema, createPgClient } from '../store/sql-migrate.js'

/**
 * Verifies the control-plane schema against a real database.
 *
 * This is the check the fake client cannot do: it proves the SQL in
 * `sql/schema.sql` actually applies, and that the version the code expects is
 * the one in place.
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is not set.')
    process.exit(1)
  }

  const client = await createPgClient({ connectionString: url, max: 1 })
  try {
    const status = await checkSchema(client)
    if (!status.ready) {
      console.error(`not ready: ${status.reason}`)
      process.exit(1)
    }

    // Prove the tables are actually usable, not merely present.
    const probe = await client.query(
      'SELECT (SELECT count(*) FROM cm_platform) AS platforms, (SELECT count(*) FROM cm_source) AS sources, (SELECT count(*) FROM cm_account) AS accounts',
    )
    const row = probe.rows[0] ?? {}
    const count = (value: unknown): number => (typeof value === 'number' ? value : Number(value ?? 0))
    console.log(
      `ready (schema v${status.version}) — ${count(row.platforms)} platforms, ${count(row.sources)} sources, ${count(row.accounts)} accounts`,
    )
  } finally {
    await client.close()
  }
}

main().catch((error: unknown) => {
  console.error('schema check failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
