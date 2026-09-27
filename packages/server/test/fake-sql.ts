import type { SqlClient, SqlResult } from '../src/store/sql-client.js'

interface Recorded {
  text: string
  params: readonly unknown[]
}

/**
 * An in-memory stand-in for Postgres.
 *
 * It understands just enough SQL to prove the mapping: inserts become rows,
 * `SELECT doc FROM <table>` returns them, and a transaction is all-or-nothing.
 * It is not a database and does not pretend to be one.
 */
export class FakeSql implements SqlClient {
  private readonly tables = new Map<string, Map<string, Record<string, unknown>>>()
  private readonly log: Recorded[] = []
  private readonly failOn: string[] = []
  private depth = 0

  failOnFragment(fragment: string): void {
    this.failOn.push(fragment)
  }

  statements(): Recorded[] {
    return [...this.log]
  }

  rowCount(table: string): number {
    return this.tables.get(table)?.size ?? 0
  }

  async query(text: string, params: readonly unknown[] = []): Promise<SqlResult> {
    this.log.push({ text, params })

    if (this.failOn.some((fragment) => text.includes(fragment))) {
      throw new Error(`fake sql: statement failed: ${text.slice(0, 40)}`)
    }

    if (text === 'BEGIN') {
      this.depth += 1
      return { rowCount: 0, rows: [] }
    }
    if (text === 'COMMIT' || text === 'ROLLBACK') {
      this.depth = Math.max(0, this.depth - 1)
      return { rowCount: 0, rows: [] }
    }

    const insert = /^INSERT INTO (\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]*)\)/i.exec(text.trim())
    if (insert) {
      const [, table, columns, values] = insert
      const table_ = this.table(table!)
      const names = columns!.split(',').map((name) => name.trim())
      const raw = values!.split(',').map((part) => part.trim())
      const row: Record<string, unknown> = {}
      names.forEach((name, index) => {
        const value = raw[index] ?? ''
        row[name] = value.startsWith('$') ? params[Number(value.slice(1)) - 1] : value
      })
      const rowId = typeof row.id === 'string' || typeof row.id === 'number' ? row.id : `row-${table_.size}`
      table_.set(String(rowId), { ...row, doc: parseJson(row.doc) })
      return { rowCount: 1, rows: [] }
    }

    const select = /^SELECT\s+(.+?)\s+FROM\s+(\w+)/i.exec(text.trim())
    if (select) {
      const [, projection, table] = select
      const rows = [...(this.tables.get(table!)?.values() ?? [])]
      const wanted = projection!.split(',').map((part) => part.trim())
      return {
        rowCount: rows.length,
        rows: rows.map((row) => {
          const result: Record<string, unknown> = {}
          for (const part of wanted) {
            const [column, alias] = part.split(/\s+as\s+/i)
            const name = (alias ?? column ?? '').trim()
            const source = (column ?? '').trim()
            if (name) result[name] = row[source]
          }
          if (result.doc !== undefined && typeof result.doc === 'string') result.doc = JSON.parse(result.doc)
          return result
        }),
      }
    }

    const del = /^DELETE FROM (\w+)/i.exec(text.trim())
    if (del?.[1]) {
      const count = this.tables.get(del[1])?.size ?? 0
      this.tables.set(del[1], new Map())
      return { rowCount: count, rows: [] }
    }

    return { rowCount: 0, rows: [] }
  }

  async transaction<T>(work: (client: SqlClient) => Promise<T>): Promise<T> {
    // Snapshot the tables so a rollback really restores them.
    const backup = new Map([...this.tables].map(([name, rows]) => [name, new Map(rows)]))
    const statements = this.log.length
    await this.query('BEGIN')
    try {
      const result = await work(this)
      await this.query('COMMIT')
      return result
    } catch (error) {
      this.log.splice(statements)
      this.log.push({ text: 'BEGIN', params: [] })
      await this.query('ROLLBACK')
      this.tables.clear()
      for (const [name, rows] of backup) this.tables.set(name, rows)
      throw error
    }
  }

  async close(): Promise<void> {
    // nothing to release
  }

  private table(name: string): Map<string, Record<string, unknown>> {
    const existing = this.tables.get(name)
    if (existing) return existing
    const created = new Map<string, Record<string, unknown>>()
    this.tables.set(name, created)
    return created
  }
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}
