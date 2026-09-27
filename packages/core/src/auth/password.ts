import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'

/**
 * Password hashing with scrypt from the Node standard library.
 *
 * No dependency, memory-hard, and the parameters are stored inside the hash so
 * they can be raised later without invalidating existing passwords.
 *
 * Format: `scrypt$N$r$p$<salt base64url>$<derived key base64url>`
 */

const COST = 16_384 // N
const BLOCK_SIZE = 8 // r
const PARALLELISM = 1 // p
const KEY_LENGTH = 64
const SALT_LENGTH = 16
const MAX_MEMORY = 64 * 1024 * 1024

function scrypt(password: string, salt: Buffer, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      keylen,
      { N: COST, r: BLOCK_SIZE, p: PARALLELISM, maxmem: MAX_MEMORY },
      (error, derived) => (error ? reject(error) : resolve(derived)),
    )
  })
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH)
  const derived = await scrypt(password, salt, KEY_LENGTH)
  return [
    'scrypt',
    COST,
    BLOCK_SIZE,
    PARALLELISM,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$')
}

/** Constant-time verification. A malformed stored hash fails closed. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false

  const cost = Number(parts[1])
  const blockSize = Number(parts[2])
  const parallelism = Number(parts[3])
  if (!Number.isFinite(cost) || !Number.isFinite(blockSize) || !Number.isFinite(parallelism)) return false

  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(parts[4] ?? '', 'base64url')
    expected = Buffer.from(parts[5] ?? '', 'base64url')
  } catch {
    return false
  }
  if (salt.length === 0 || expected.length === 0) return false

  const derived = await scryptWith(password, salt, expected.length, cost, blockSize, parallelism)
  return derived.length === expected.length && timingSafeEqual(derived, expected)
}

function scryptWith(
  password: string,
  salt: Buffer,
  keylen: number,
  cost: number,
  blockSize: number,
  parallelism: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      keylen,
      { N: cost, r: blockSize, p: parallelism, maxmem: MAX_MEMORY },
      (error, derived) => (error ? reject(error) : resolve(derived)),
    )
  })
}

export interface PasswordPolicy {
  minLength: number
  maxLength: number
  problems: string[]
}

/** Plain-language rules, returned as problems the sign-up form can show. */
export function checkPasswordPolicy(password: string, minLength = 10): PasswordPolicy {
  const maxLength = 200
  const problems: string[] = []

  if (password.length < minLength) problems.push(`Use at least ${minLength} characters.`)
  if (password.length > maxLength) problems.push(`Use fewer than ${maxLength} characters.`)
  if (password.length > 0 && !/[a-z]/i.test(password)) problems.push('Include at least one letter.')
  if (!/\d/.test(password)) problems.push('Include at least one number.')

  return { minLength, maxLength, problems }
}
