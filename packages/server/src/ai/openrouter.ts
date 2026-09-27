import type { ModelClient } from '@creator-mall/core'

/**
 * OpenRouter chat-completions client.
 *
 * Design rules, in order of importance:
 *  1. the API key is never logged, never returned, never included in errors;
 *  2. every call is bounded by a timeout and a token cap, so a research cycle
 *     cannot run away in cost or time;
 *  3. a provider failure is an ordinary error the caller handles by falling back
 *     to the deterministic extractor.
 */

export interface ProviderConfig {
  apiKey: string
  model: string
  baseUrl: string
  timeoutMs: number
  referer?: string
  title?: string
}

export class ProviderError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.name = 'ProviderError'
    this.status = status
  }
}

export class OpenRouterClient implements ModelClient {
  readonly name: string
  private readonly config: ProviderConfig
  private readonly fetchImpl: typeof fetch

  constructor(config: ProviderConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config
    this.fetchImpl = fetchImpl
    this.name = config.model
  }

  async complete(input: { system: string; user: string; maxTokens: number }): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs)

    let response: Response
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          'content-type': 'application/json',
          ...(this.config.referer ? { 'http-referer': this.config.referer } : {}),
          ...(this.config.title ? { 'x-title': this.config.title } : {}),
        },
        body: JSON.stringify({
          model: this.config.model,
          temperature: 0,
          max_tokens: input.maxTokens,
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: input.user },
          ],
        }),
      })
    } catch (error) {
      throw new ProviderError(
        error instanceof Error && error.name === 'AbortError'
          ? `model call timed out after ${this.config.timeoutMs}ms`
          : 'model call failed',
      )
    } finally {
      clearTimeout(timer)
    }

    if (!response.ok) {
      // The body can echo request details, so only the status is surfaced.
      throw new ProviderError(`model call returned http ${response.status}`, response.status)
    }

    const payload: unknown = await response.json().catch(() => null)
    return readContent(payload)
  }
}

function readContent(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return ''
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return ''
  const message = (choices[0] as { message?: { content?: unknown } }).message
  const content = message?.content
  return typeof content === 'string' ? content : ''
}

export function isModelConfigured(apiKey: string): boolean {
  return apiKey.trim().length > 0
}

/** Redacts anything key-shaped, for logs and error surfaces. */
export function redactSecrets(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/(authorization"?\s*[:=]\s*"?)([^"\s,}]+)/gi, '$1***')
}
