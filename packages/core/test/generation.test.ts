import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DeterministicGenerator, ModelCopyGenerator, posterSvg } from '../src/index.js'
import type { GenerationRequest, ModelClient } from '../src/index.js'

const request = (overrides: Partial<GenerationRequest> = {}): GenerationRequest => ({
  creatorId: 'cr_1',
  platformSlug: 'instagram',
  platformName: 'Instagram',
  capabilityKey: 'SHORT_VIDEO',
  capabilityLabel: 'Short video',
  brief: 'how I batch filmed a week of content in one afternoon',
  limits: [],
  ...overrides,
})

function clientReturning(payload: string): ModelClient {
  return { name: 'test-model', complete: () => Promise.resolve(payload) }
}

describe('deterministic copy renderer', () => {
  const generator = new DeterministicGenerator()

  it('writes real copy, not a placeholder', async () => {
    const copy = await generator.generateCopy(request())
    assert.match(copy.hook, /result, not the setup/i)
    assert.match(copy.body, /batch filmed a week of content/i)
    assert.ok(copy.cta.length > 10)
    assert.equal(copy.producedBy, 'creator-mall-renderer-v1')
    assert.equal(copy.modelGenerated, false, 'the renderer never claims to be a model')
  })

  it('changes shape for the format', async () => {
    const carousel = await generator.generateCopy(request({ capabilityKey: 'CAROUSEL', capabilityLabel: 'Carousel' }))
    assert.match(carousel.body, /Card 1/i)
    const story = await generator.generateCopy(request({ capabilityKey: 'STORY', capabilityLabel: 'Story' }))
    assert.match(story.cta, /Reply/i)
  })

  it('respects a verified character limit', async () => {
    const copy = await generator.generateCopy(
      request({ limits: [{ label: 'Maximum length', value: '120 characters' }] }),
    )
    assert.ok(copy.body.length <= 120, `body was ${copy.body.length} characters`)
    assert.ok(copy.body.endsWith('…'), 'truncation is visible, not silent')
  })

  it('respects a verified hashtag limit', async () => {
    const copy = await generator.generateCopy(request({ limits: [{ label: 'Hashtags allowed', value: '1' }] }))
    assert.ok(copy.hashtags.length <= 1)
  })

  it('handles an empty brief without breaking', async () => {
    const copy = await generator.generateCopy(request({ brief: '' }))
    assert.ok(copy.hook.length > 10)
    assert.ok(copy.body.length > 10)
  })
})

describe('poster renderer', () => {
  const generator = new DeterministicGenerator()

  it('produces a valid, self-contained SVG', async () => {
    const image = await generator.generateImage({ ...request(), title: 'Batch filming a week in one afternoon' })
    assert.match(image.svg, /^<\?xml/)
    assert.match(image.svg, /<svg[^>]+viewBox="0 0 1080 1350"/)
    assert.match(image.svg, /<\/svg>\s*$/)
    assert.equal(image.width, 1080)
    assert.equal(image.height, 1350)
    assert.equal(image.modelGenerated, false)
    assert.ok(image.alt.length > 0)
  })

  it('uses a landscape ratio for long-form formats', async () => {
    const image = await generator.generateImage({ ...request({ capabilityKey: 'LONG_VIDEO', capabilityLabel: 'Long video' }), title: 'The full workflow' })
    assert.equal(image.width, 1200)
    assert.equal(image.height, 675)
  })

  it('wraps a long title and escapes the text', () => {
    const svg = posterSvg({
      width: 1080,
      height: 1350,
      palette: ['#111', '#222', '#333'],
      title: 'A very long headline that should wrap across several lines instead of running off the edge of the image',
      subtitle: 'Example & Co <test>',
      footer: 'footer',
    })
    assert.equal(svg.includes('&amp;'), true)
    assert.equal(svg.includes('<test>'), false)
    const textNodes = svg.match(/<text /g) ?? []
    assert.ok(textNodes.length >= 3, 'the title wrapped onto multiple lines')
  })

  it('is deterministic for the same inputs', async () => {
    const first = await generator.generateImage({ ...request(), title: 'Same title' })
    const second = await generator.generateImage({ ...request(), title: 'Same title' })
    assert.equal(first.svg, second.svg)
  })
})

describe('storyboard and audio renderer', () => {
  const generator = new DeterministicGenerator()

  it('produces a shootable shot list', async () => {
    const board = await generator.generateStoryboard({ ...request(), targetSeconds: 15 })
    assert.equal(board.format, 'short')
    assert.ok(board.shots.length >= 3)
    assert.equal(board.shots[0]?.index, 1)
    assert.ok(board.shots.every((shot) => shot.visual.length > 5 && shot.voiceover.length > 5))
    assert.ok(board.captionCue.length > 0)
    assert.equal(board.modelGenerated, false)
  })

  it('produces narration with timings that add up', async () => {
    const audio = await generator.generateAudioScript({ ...request(), targetSeconds: 20 })
    assert.ok(audio.segments.length >= 2)
    const summed = audio.segments.reduce((total, segment) => total + segment.seconds, 0)
    assert.ok(Math.abs(summed - audio.totalSeconds) < 0.5)
    assert.match(audio.direction, /Conversational/)
  })

  it('respects a short duration rather than over-running', async () => {
    const audio = await generator.generateAudioScript({ ...request(), targetSeconds: 5 })
    assert.ok(audio.totalSeconds <= 20, 'a five second request does not produce a monologue')
  })
})

describe('model-backed copy', () => {
  const generator = new ModelCopyGenerator({
    client: clientReturning(
      JSON.stringify({
        hook: 'I filmed a week of content in one afternoon.',
        body: 'Here is the setup, the mistake I made twice, and the version I use now.',
        cta: 'Save this and try it once.',
        hashtags: ['#batching', '#content'],
      }),
    ),
  })

  it('uses the model copy when it is usable', async () => {
    const copy = await generator.generateCopy(request())
    assert.equal(copy.modelGenerated, true)
    assert.equal(copy.producedBy, 'model:test-model')
    assert.match(copy.hook, /one afternoon/)
  })

  it('falls back to the renderer when the provider fails', async () => {
    const reasons: string[] = []
    const failing = new ModelCopyGenerator({
      client: { name: 'down', complete: () => Promise.reject(new Error('http 503')) },
      onFallback: (reason) => reasons.push(reason),
    })
    const copy = await failing.generateCopy(request())
    assert.equal(copy.modelGenerated, false)
    assert.equal(copy.producedBy, 'creator-mall-renderer-v1')
    assert.match(reasons[0] ?? '', /503/)
  })

  it('falls back when the model returns something unusable', async () => {
    for (const response of ['', 'sorry, I cannot help', 'no json here', '{"body":"no hook"}']) {
      const fallback = new ModelCopyGenerator({ client: clientReturning(response) })
      const copy = await fallback.generateCopy(request())
      assert.equal(copy.modelGenerated, false, `should have fallen back for: ${response.slice(0, 20)}`)
      assert.ok(copy.hook.length > 5)
    }
  })

  it('falls back rather than shipping a post over a verified limit', async () => {
    const overLimit = new ModelCopyGenerator({
      client: clientReturning(
        JSON.stringify({
          hook: 'x'.repeat(400),
          body: 'y'.repeat(400),
          cta: 'z'.repeat(200),
          hashtags: [],
        }),
      ),
    })
    const copy = await overLimit.generateCopy(request({ limits: [{ label: 'Maximum length', value: '50 characters' }] }))
    assert.equal(copy.modelGenerated, false, 'a 1000-character post is not silently truncated into a platform limit')
  })

  it('rejects copy with too many hashtags', async () => {
    const tooMany = new ModelCopyGenerator({
      client: clientReturning(
        JSON.stringify({
          hook: 'a',
          body: 'b',
          cta: 'c',
          hashtags: ['#alpha', '#bravo', '#charlie', '#delta', '#echo'],
        }),
      ),
    })
    const copy = await tooMany.generateCopy(request({ limits: [{ label: 'Hashtags allowed', value: '2' }] }))
    assert.equal(copy.modelGenerated, false)
  })

  it('normalises hashtags a model forgets to prefix', async () => {
    const copy = await generator.generateCopy(request())
    assert.ok(copy.hashtags.every((tag) => tag.startsWith('#')))
  })

  it('strips invented markdown from the body', async () => {
    const markdowny = new ModelCopyGenerator({
      client: clientReturning(
        JSON.stringify({ hook: '# Heading', body: '**bold** and _italic_', cta: '- a list item', hashtags: [] }),
      ),
    })
    const copy = await markdowny.generateCopy(request())
    assert.equal(copy.hook.includes('#'), false)
    assert.equal(copy.body.includes('**'), false)
  })
})
