#!/usr/bin/env node
/**
 * One-off check that the configured model provider answers.
 *
 * It prints the model name and a one-line result. It never prints the key, and
 * it is not part of `npm run verify` because it costs money and needs a key.
 */
import { loadConfig } from '../packages/server/dist/config.js'
import { OpenRouterClient, isModelConfigured, redactSecrets } from '../packages/server/dist/ai/openrouter.js'

const config = loadConfig()

if (!isModelConfigured(config.OPENROUTER_API_KEY)) {
  console.log('no provider key configured — the deterministic extractor is in use')
  process.exit(0)
}

const client = new OpenRouterClient({
  apiKey: config.OPENROUTER_API_KEY,
  model: config.OPENROUTER_MODEL,
  baseUrl: config.OPENROUTER_BASE_URL,
  timeoutMs: config.MODEL_TIMEOUT_MS,
  title: 'Creator Mall provider check',
})

try {
  const answer = await client.complete({
    system: 'Reply with a single word.',
    user: 'Say: ready',
    maxTokens: 16,
  })
  console.log(`model ${config.OPENROUTER_MODEL} -> ${redactSecrets(answer).trim().slice(0, 80) || '(empty response)'}`)
} catch (error) {
  console.error(`provider check failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`)
  process.exit(1)
}
