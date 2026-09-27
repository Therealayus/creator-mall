import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { ControlPlaneState, PersistencePort } from './persistence.js'

/**
 * Durable control-plane state as a single JSON document.
 *
 * Writes are atomic (temp file + rename) so a crash mid-write cannot leave a
 * truncated control plane, which would look like data loss to the research
 * engine. In production this is where Postgres takes over.
 */
export class FilePersistence implements PersistencePort {
  private readonly file: string

  constructor(dataDir: string) {
    this.file = join(dataDir, 'control-plane.json')
  }

  async load(): Promise<ControlPlaneState | null> {
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as ControlPlaneState
      return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async save(state: ControlPlaneState): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })

    // A unique temp name per save. A shared one let two concurrent writers
    // interleave, and on Windows the loser's rename fails with EPERM, leaving a
    // stray .tmp and a 500 on an otherwise successful request.
    const temp = `${this.file}.${process.pid}.${randomUUID()}.tmp`

    // Compact, not pretty. This is machine state that is rewritten on every
    // mutating request; the 2-space indent made every write roughly 1.4x larger
    // and correspondingly slower to serialise.
    const handle = await open(temp, 'w')
    try {
      await handle.writeFile(JSON.stringify(state), 'utf8')
      // Flush before the rename, so a crash cannot leave a renamed file whose
      // contents never reached the disk.
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, this.file)
  }
}
