import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
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
    const temp = `${this.file}.tmp`
    await writeFile(temp, JSON.stringify(state, null, 2), 'utf8')
    await rename(temp, this.file)
  }
}
