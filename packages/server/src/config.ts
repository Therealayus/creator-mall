/** Runtime configuration. Everything is env-driven so nothing is hardcoded. */
import { z } from 'zod'

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('127.0.0.1'),
  NODE_ENV: z.string().default('development'),

  /** Bearer token for admin/evolution routes. Empty disables auth (dev only). */
  ADMIN_TOKEN: z.string().default(''),

  /** Directory for the JSON control-plane snapshot. Empty = memory only. */
  DATA_DIR: z.string().default(''),

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
})

export type Config = z.infer<typeof schema> & { allowedHosts: Set<string> }

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
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
