import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/**
 * The database is reached through a tiny interface rather than `pg` directly.
 *
 * That keeps the mapping logic testable with a fake client, and keeps the
 * driver optional: nothing imports `pg` until a connection is actually made.
 */
export interface SqlResult {
  rowCount: number
  rows: Record<string, unknown>[]
}

export interface SqlClient {
  query(text: string, params?: readonly unknown[]): Promise<SqlResult>
  transaction<T>(work: (client: SqlClient) => Promise<T>): Promise<T>
  close(): Promise<void>
}

export interface SqlClientOptions {
  connectionString: string
  max?: number
  /** Statement timeout, so a stuck query cannot hang the control plane. */
  statementTimeoutMs?: number
}

/** Lazy `pg` import: the driver is only required when a database is used. */
export async function createPgClient(options: SqlClientOptions): Promise<SqlClient> {
  const { default: pg } = (await import('pg')) as unknown as { default: { Pool: new (config: unknown) => PgLike } }

  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 5,
    statement_timeout: options.statementTimeoutMs ?? 10_000,
  })

  return {
    async query(text, params = []) {
      const result = await pool.query(text, [...params])
      return { rowCount: result.rowCount ?? 0, rows: (result.rows ?? []) as Record<string, unknown>[] }
    },
    async transaction(work) {
      const client = await pool.connect()
      const scoped: SqlClient = {
        async query(text, params = []) {
          const result = await client.query(text, [...params])
          return { rowCount: result.rowCount ?? 0, rows: (result.rows ?? []) as Record<string, unknown>[] }
        },
        async transaction(inner) {
          return inner(scoped)
        },
        async close() {
          client.release()
          return Promise.resolve()
        },
      }
      try {
        await scoped.query('BEGIN')
        const value = await work(scoped)
        await scoped.query('COMMIT')
        return value
      } catch (error) {
        await scoped.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        await scoped.close()
      }
    },
    async close() {
      await pool.end()
    },
  }
}

interface PgLike {
  query(text: string, params?: unknown[]): Promise<{ rowCount: number | null; rows: unknown[] }>
  connect(): Promise<{
    query(text: string, params?: unknown[]): Promise<{ rowCount: number | null; rows: unknown[] }>
    release(): void
  }>
  end(): Promise<void>
}

export async function readSchema(): Promise<string> {
  // Resolves to packages/server/sql/schema.sql from both src/store/ and
  // dist/store/. The old single `..` pointed at src/sql/, which does not exist,
  // so `npm run db:migrate` failed with ENOENT before running a single statement.
  return readFile(fileURLToPath(new URL('../../sql/schema.sql', import.meta.url)), 'utf8')
}
