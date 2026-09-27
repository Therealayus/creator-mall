/** Runtime configuration. Everything is env-driven so nothing is hardcoded. */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { config as loadDotenv } from 'dotenv'
import { z } from 'zod'

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('127.0.0.1'),
  NODE_ENV: z.string().default('development'),

  /** Bearer token for admin/evolution routes. Empty disables auth (dev only). */
  ADMIN_TOKEN: z.string().default(''),

  // ─── Accounts and sessions ────────────────────────────────────────────────
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(24 * 14),
  PASSWORD_MIN_LENGTH: z.coerce.number().int().min(6).max(64).default(10),
  REGISTRATION_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value !== 'false'),
  /** Always true behind TLS; set explicitly when terminating TLS elsewhere. */
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  /**
   * Creator the web app acts as until real accounts exist (Phase 3).
   * Empty = the single seeded demo creator.
   */
  CREATOR_ID: z.string().default(''),

  /** Directory for the JSON control-plane snapshot. Empty = memory only. */
  DATA_DIR: z.string().default(''),
  /**
   * Where generated and uploaded asset bytes live. Defaults to files under
   * DATA_DIR when one is configured, and memory otherwise.
   */
  ASSET_STORAGE: z.enum(['file', 'memory']).optional(),

  /** World Engine cadence. */
  RESEARCH_INTERVAL_MS: z.coerce.number().int().min(30_000).default(15 * 60_000),
  RESEARCH_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /** Research only runs when explicitly triggered unless enabled. */
  FETCH_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(15_000),
  FETCH_MAX_BYTES: z.coerce.number().int().min(10_000).default(2_000_000),
  FETCH_USER_AGENT: z.string().default('CreatorMallBot/0.1 (+https://creatormall.example/bot)'),
  FETCH_MIN_HOST_GAP_MS: z.coerce.number().int().min(0).default(2_000),
  RESPECT_ROBOTS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  /** Comma-separated hosts the World Engine is allowed to read. */
  ALLOWED_HOSTS: z.string().default(''),

  /**
   * Optional model provider for fact extraction. When no key is configured the
   * deterministic extractor is used, so the World Engine never depends on it.
   */
  OPENROUTER_API_KEY: z.string().default(''),
  OPENROUTER_MODEL: z.string().default('openrouter/stealth/space-bunny-alpha'),
  OPENROUTER_BASE_URL: z.string().default('https://openrouter.com/api/v1'),
  MODEL_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  MODEL_MAX_INPUT_CHARS: z.coerce.number().int().min(500).max(60_000).default(12_000),
  /** Disable model extraction entirely even when a key is present. */
  MODEL_EXTRACTION: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  // ─── Embeddings (optional) ──────────────────────────────────────────────────
  // Unset means the deterministic local provider: no key, no network, and
  // nothing about a creator leaving the machine.
  EMBEDDING_BASE_URL: z.string().default('https://openrouter.com/api/v1'),
  EMBEDDING_MODEL: z.string().default('openai/text-embedding-3-small'),

  // ─── Storage ───────────────────────────────────────────────────────────────
  DATABASE_URL: z.string().default(''),
  /** `json` keeps the file snapshot; `postgres` uses the control-plane tables. */
  PERSISTENCE: z.enum(['json', 'postgres']).default('json'),
  DB_POOL_SIZE: z.coerce.number().int().min(1).max(50).default(5),
})

export type Config = z.infer<typeof schema> & { allowedHosts: Set<string> }

let dotenvLoaded = false

/**
 * Loads `.env` for local development. Real environment variables always win, so
 * a deployment's secret store is never overridden by a file. `.env` is
 * gitignored and must never be committed.
 */
function loadLocalEnvFile(): void {
  if (dotenvLoaded) return
  dotenvLoaded = true
  const file = resolve(process.cwd(), '.env')
  if (existsSync(file)) loadDotenv({ path: file, quiet: true })
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env === process.env) loadLocalEnvFile()
  const parsed = schema.parse(env)
  const allowedHosts = new Set(
    parsed.ALLOWED_HOSTS.split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  )
  return { ...parsed, allowedHosts }
}

export function isProduction(config: Config): boolean {
  return config.NODE_ENV === 'production'
}
