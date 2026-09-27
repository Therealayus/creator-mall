import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CapabilityRegistry, ModelFactExtractor, sanitizeModelFacts } from '../src/index.js'
import type { ExtractInput, ModelClient } from '../src/index.js'

const registry = new CapabilityRegistry()

const page = [
  'Creator Reels can be up to 90 seconds long, and up to 4 GB per video file.',
  'A post can contain up to 10 photos in a single carousel.',
  'Your bio is limited to 150 characters, and you can add up to 5 links.',
  'Stories expire after 24 hours unless you archive them.',
].join('\n')

const input: ExtractInput = {
  platformId: 'pf_1',
  platformName: 'Example',
  text: page,
  sourceId: 'src_1',
  capabilityRegistry: registry,
}

function clientReturning(payload: string): ModelClient {
  return {
    name: 'test',
    complete: () => Promise.resolve(payload),
  }
}

describe('model fact extractor', () => {
  it('parses a fenced JSON array into facts', async () => {
    const extractor = new ModelFactExtractor({
      client: clientReturning(
        '```json\n[{"path":"limits.video.maxDurationSeconds","value":90,"statement":"Maximum video length is 90 seconds.","evidence":"Creator Reels can be up to 90 seconds long, and up to 4 GB per video file.","category":"CONTENT_LIMIT","capabilityKeys":["SHORT_VIDEO"]}]\n```',
      ),
    })
    const facts = await extractor.extract(input)

    assert.equal(facts.length, 1)
    assert.equal(facts[0]?.path, 'limits.video.maxDurationSeconds')
    assert.equal(facts[0]?.value, 90)
    assert.deepEqual(facts[0]?.capabilityKeys, ['SHORT_VIDEO'])
    assert.equal(facts[0]?.sourceId, 'src_1')
  })

  it('drops a claim whose evidence is not on the page', async () => {
    const facts = await new ModelFactExtractor({
      client: clientReturning(
        JSON.stringify([
          {
            path: 'limits.video.maxDurationSeconds',
            value: 600,
            statement: 'Maximum video length is 10 minutes.',
            evidence: 'Videos may be up to 10 minutes long in our current documentation.',
            category: 'CONTENT_LIMIT',
          },
        ]),
      ),
    }).extract(input)

    assert.deepEqual(facts, [])
  })

  it('drops page furniture even when the model insists', async () => {
    const boilerplate = 'This browser is no longer supported. Please upgrade to a modern browser to continue.'
    const facts = await new ModelFactExtractor({
      client: clientReturning(
        JSON.stringify([
          {
            path: 'policies',
            value: boilerplate,
            statement: 'Browser support notice.',
            evidence: boilerplate,
            category: 'POLICY_CHANGE',
          },
        ]),
      ),
    }).extract({ ...input, text: `${boilerplate}\n${page}` })

    assert.deepEqual(facts, [])
  })

  it('caps confidence because a model is not a source', async () => {
    const facts = sanitizeModelFacts(
      [
        {
          path: 'limits.text.maxCharacters',
          value: 150,
          statement: 'Bio limited to 150 characters.',
          evidence: 'Your bio is limited to 150 characters, and you can add up to 5 links.',
          category: 'CHARACTER_LIMIT',
          confidence: 1,
        },
      ],
      input,
    )
    assert.equal(facts[0]?.confidence, 0.8)
  })

  it('rejects unknown areas and unknown categories', () => {
    const facts = sanitizeModelFacts(
      [
        {
          path: 'secrets.apiKey',
          value: 'abc',
          statement: 'leak',
          evidence: 'Stories expire after 24 hours unless you archive them.',
          category: 'MADE_UP_CATEGORY',
        },
      ],
      input,
    )
    assert.deepEqual(facts, [])
  })

  it('ignores capability keys the registry does not know', () => {
    const facts = sanitizeModelFacts(
      [
        {
          path: 'limits.media.maxImages',
          value: 10,
          statement: 'Up to 10 photos per carousel.',
          evidence: 'A post can contain up to 10 photos in a single carousel.',
          category: 'CONTENT_LIMIT',
          capabilityKeys: ['CAROUSEL', 'TOTALLY_MADE_UP'],
        },
      ],
      input,
    )
    assert.deepEqual(facts[0]?.capabilityKeys, ['CAROUSEL'])
  })

  it('de-duplicates repeated claims', () => {
    const evidence = 'Stories expire after 24 hours unless you archive them.'
    const facts = sanitizeModelFacts(
      [
        { path: 'limits.text.maxCharacters', value: 24, statement: 'a', evidence },
        { path: 'limits.text.maxCharacters', value: 48, statement: 'b', evidence },
      ],
      input,
    )
    assert.equal(facts.length, 1)
  })

  it('survives a useless response', async () => {
    for (const response of ['', 'I could not find any facts.', 'not json at all', '{"facts": []}']) {
      const facts = await new ModelFactExtractor({ client: clientReturning(response) }).extract(input)
      assert.deepEqual(facts, [])
    }
  })

  it('skips the model entirely for a page with no real text', async () => {
    let called = false
    const extractor = new ModelFactExtractor({
      client: {
        name: 'test',
        complete: () => {
          called = true
          return Promise.resolve('[]')
        },
      },
    })
    const facts = await extractor.extract({ ...input, text: 'too short' })
    assert.deepEqual(facts, [])
    assert.equal(called, false)
  })

  it('truncates very long pages before sending them', async () => {
    let seen = ''
    const extractor = new ModelFactExtractor({
      client: {
        name: 'test',
        complete: (request) => {
          seen = request.user
          return Promise.resolve('[]')
        },
      },
      maxInputChars: 500,
    })
    await extractor.extract({ ...input, text: `${page}\n${'x'.repeat(10_000)}` })
    assert.ok(seen.length < 2_000)
  })
})
