import { createPgClient } from '../store/sql-migrate.js'
import { checkSchema, migrate } from '../store/sql-migrate.js'

/** Applies the control-plane schema. Needs DATABASE_URL. */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is not set. Nothing to migrate.')
    process.exit(1)
  }

  const client = await createPgClient({ connectionString: url, max: 1 })
  try {
    const result = await migrate(client)
    console.log(`applied ${result.statements} statements`)
    const check = await checkSchema(client)
    console.log(check.ready ? `schema version ${check.version}: ready` : `not ready: ${check.reason}`)
  } finally {
    await client.close()
  }
}

main().catch((error: unknown) => {
  console.error('migration failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
