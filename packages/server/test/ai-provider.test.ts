import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { OpenRouterClient, ProviderError, isModelConfigured, redactSecrets } from '../src/ai/openrouter.js'
import { ModelFactExtractor } from '@creator-mall/core'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const IGNORED_DIRS = new Set(['node_modules', 'dist', '.git', 'data', 'coverage'])
const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml', '.html', '.css']
const SECRET_PATTERN = /sk-[A-Za-z0-9_-]{16,}/

function scriptableFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const { status, body } = handler(url, init ?? {})
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}

function completion(content: string): { choices: Array<{ message: { content: string } }> } {
  return { choices: [{ message: { content } }] }
}

/** Reads a numeric leaf out of a snapshot area without fighting the JSON types. */
function numericLeaf(
  state: { mediaSpecs: unknown; limits: unknown },
  area: 'mediaSpecs' | 'limits',
  path: string,
): unknown {
  const root = state[area] as Record<string, Record<string, unknown>> | undefined
  return root?.[path.split('.')[0] ?? '']?.[path.split('.')[1] ?? '']
}
describe('openrouter client', () => {
  it('sends the model request and returns the completion', async () => {
    let seenInit: RequestInit | null = null
    const client = new OpenRouterClient(
      {
        apiKey: 'sk-test-key-value-not-real',
        model: 'openrouter/stealth/space-bunny-alpha',
        baseUrl: 'https://openrouter.test/api/v1',
        timeoutMs: 5_000,
      },
      scriptableFetch((url, init) => {
        seenInit = init
        assert.match(url, /\/chat\/completions$/)
        return { status: 200, body: completion('[{"path":"limits.text.maxCharacters","value":100}]') }
      }),
    )

    const out = await client.complete({ system: 's', user: 'u', maxTokens: 500 })
    assert.equal(out, '[{"path":"limits.text.maxCharacters","value":100}]')
    const headers = (seenInit as unknown as { headers: Record<string, string> }).headers
    assert.match(String(headers.authorization), /^Bearer sk-/)
    const body = JSON.parse((seenInit as unknown as { body: string }).body)
    assert.equal(body.model, 'openrouter/stealth/space-bunny-alpha')
    assert.equal(body.temperature, 0)
    assert.equal(body.max_tokens, 500)
  })

  it('never leaks the key in an error', async () => {
    const client = new OpenRouterClient(
      {
        apiKey: 'sk-secret-key-that-must-not-appear',
        model: 'm',
        baseUrl: 'https://openrouter.test/api/v1',
        timeoutMs: 5_000,
      },
      scriptableFetch(() => ({ status: 401, body: { error: 'invalid key sk-secret-key-that-must-not-appear' } })),
    )

    await assert.rejects(
      () => client.complete({ system: 's', user: 'u', maxTokens: 10 }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError)
        assert.equal(error.message.includes('sk-secret'), false)
        assert.match(error.message, /http 401/)
        return true
      },
    )
  })

  it('treats an unusable response as empty rather than throwing', async () => {
    const client = new OpenRouterClient(
      { apiKey: 'sk-x', model: 'm', baseUrl: 'https://openrouter.test/api/v1', timeoutMs: 5_000 },
      scriptableFetch(() => ({ status: 200, body: { choices: [] } })),
    )
    assert.equal(await client.complete({ system: 's', user: 'u', maxTokens: 10 }), '')
  })

  it('redacts key-shaped strings for logs', () => {
    const redacted = redactSecrets('failed with sk-or-v1-abcdefghijklmnop and authorization: Bearer sk-xyz123456789')
    assert.equal(redacted.includes('abcdefghijklmnop'), false)
    assert.equal(redacted.includes('sk-xyz123456789'), false)
  })

  it('knows when no provider is configured', () => {
    assert.equal(isModelConfigured(''), false)
    assert.equal(isModelConfigured('   '), false)
    assert.equal(isModelConfigured('sk-something'), true)
  })
})

describe('research cycle with a model provider', () => {
  it('merges model facts with deterministic facts and never duplicates a claim', async () => {
    const { runResearchCycle } = await import('../src/world-engine/pipeline.js')
    const { testContext, html, ROBOTS_ALLOW_ALL, CLOCK } = await import('./helpers.js')

    const page = [
      '<p>Reels can be up to 90 seconds long.</p>',
      '<p>Stories expire after 24 hours unless you archive them.</p>',
      '<p>Carousel posts can hold up to 10 photos in a single post.</p>',
      '<p>Your bio is limited to 150 characters, and you can add up to 5 links to it.</p>',
      '<p>Video files must be under 4 GB and exported in MP4 or MOV container format.</p>',
    ].join('')

    const routes: Record<string, { body: string; contentType: string }> = {
      'https://creators.instagram.com/robots.txt': { body: ROBOTS_ALLOW_ALL, contentType: 'text/plain' },
      'https://creators.instagram.com/': { body: html(page), contentType: 'text/html' },
    }
    const context = await testContext(routes)

    const modelExtractor = new ModelFactExtractor({
      client: {
        name: 'stub',
        complete: () =>
          Promise.resolve(
            JSON.stringify([
              {
                path: 'limits.video.maxDurationSeconds',
                value: 90,
                statement: 'Maximum video length is 90 seconds.',
                evidence: 'Reels can be up to 90 seconds long.',
                category: 'CONTENT_LIMIT',
                capabilityKeys: ['SHORT_VIDEO'],
              },
              {
                path: 'mediaSpecs.image.maxWidthPx',
                value: 1080,
                statement: 'Images are capped at 1080 pixels wide.',
                evidence: 'Stories expire after 24 hours unless you archive them.',
                category: 'IMAGE_SPEC',
              },
            ]),
          ),
      },
    })

    const result = await runResearchCycle({
      control: context.control,
      fetcher: context.fetcher,
      modelExtractor,
      respectSchedule: false,
      maxSourcesPerRun: 1,
      clock: CLOCK,
    })

    const platformId = context.control.getPlatform('instagram')!.id
    const snapshot = context.control.latestSnapshot(platformId)!
    // The model contributed the image spec the deterministic extractor cannot see.
    assert.equal(numericLeaf(snapshot.state, 'mediaSpecs', 'image.maxWidthPx'), 1080)
    // The limit is stated once, by whichever extractor had higher confidence.
    assert.equal(numericLeaf(snapshot.state, 'limits', 'video.maxDurationSeconds'), 90)
    assert.deepEqual(result.modelFallbacks, [])
  })

  it('falls back to deterministic extraction when the provider fails', async () => {
    const { runResearchCycle } = await import('../src/world-engine/pipeline.js')
    const { testContext, html, ROBOTS_ALLOW_ALL, CLOCK } = await import('./helpers.js')

    const routes: Record<string, { body: string; contentType: string }> = {
      'https://creators.instagram.com/robots.txt': { body: ROBOTS_ALLOW_ALL, contentType: 'text/plain' },
      'https://creators.instagram.com/': {
        body: html('<p>Reels can be up to 90 seconds long.</p>'),
        contentType: 'text/html',
      },
    }
    const context = await testContext(routes)
    const reasons: string[] = []

    const result = await runResearchCycle({
      control: context.control,
      fetcher: context.fetcher,
      modelExtractor: {
        name: 'broken',
        extract: () => Promise.reject(new Error('model call returned http 503')),
      },
      onModelFallback: (reason) => reasons.push(reason),
      respectSchedule: false,
      maxSourcesPerRun: 1,
      clock: CLOCK,
    })

    assert.ok(reasons.length > 0)
    assert.match(reasons[0]!, /503/)
    assert.ok(result.modelFallbacks.length > 0)
    // Research still produced a snapshot from the deterministic path.
    assert.equal(result.snapshotsCreated > 0, true)
    const platformId = context.control.getPlatform('instagram')!.id
    assert.equal(numericLeaf(context.control.latestSnapshot(platformId)?.state ?? { mediaSpecs: {}, limits: {} }, 'limits', 'video.maxDurationSeconds'), 90)
  })
})

describe('credential hygiene', () => {
  it('keeps provider keys out of every tracked file', async () => {
    const offenders: string[] = []
    // This file necessarily contains key-shaped strings in order to test
    // redaction, so it is the single exemption.
    const SELF = 'ai-provider.test.ts'

    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
          await walk(join(dir, entry.name))
          continue
        }
        if (entry.name === SELF) continue
        // Local, gitignored files are where a key is allowed to live.
        if (entry.name === '.env' || entry.name.endsWith('.log')) continue
        if (!SCANNED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) continue

        const content = await readFile(join(dir, entry.name), 'utf8')
        if (SECRET_PATTERN.test(content)) offenders.push(relative(REPO_ROOT, join(dir, entry.name)))
      }
    }

    await walk(REPO_ROOT)
    assert.deepEqual(
      offenders,
      [],
      `provider keys must never be committed. Found in: ${offenders.join(', ')}`,
    )
  })
})
