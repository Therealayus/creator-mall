/** Shared tiny helpers: ids, time, hashing, deterministic JSON. Kept dependency-free. */
import { createHash } from 'node:crypto'

export function nowIso(clock: () => number = Date.now): string {
  return new Date(clock()).toISOString()
}

export function addMs(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString()
}

export function diffDays(fromIso: string, toIso: string): number {
  return (new Date(toIso).getTime() - new Date(fromIso).getTime()) / 86_400_000
}

export function isExpired(iso: string | null, clock: () => number = Date.now): boolean {
  if (!iso) return false
  return new Date(iso).getTime() <= clock()
}

let counter = 0

/** Readable, sortable, collision-resistant enough for a single-process control plane. */
export function newId(prefix: string, clock: () => number = Date.now): string {
  counter = (counter + 1) % 1_000_000
  const time = clock().toString(36)
  const seq = counter.toString(36).padStart(4, '0')
  const rand = Math.floor(Math.random() * 0xffffff)
    .toString(36)
    .padStart(5, '0')
  return `${prefix}_${time}${seq}${rand}`
}

/** Deterministic id derived from content: re-running research is idempotent. */
export function stableId(prefix: string, ...parts: string[]): string {
  const hash = createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16)
  return `${prefix}_${hash}`
}

export function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Key-sorted JSON so hashes are stable regardless of insertion order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

export function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => (word.length <= 2 ? word.toUpperCase() : word[0]!.toUpperCase() + word.slice(1)))
    .join(' ')
}
