import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { composeDraft, seedTemplateFor } from '../src/index.js'
import type { TemplateDefinition } from '../src/index.js'

const platform = {
  platformId: 'pf_example',
  platformSlug: 'example',
  platformName: 'Example',
  capabilityKey: 'SHORT_VIDEO',
  capabilityLabel: 'Short video',
  createdAt: '2026-09-27T00:00:00.000Z',
}

const request = {
  platformId: platform.platformId,
  platformName: platform.platformName,
  platformSlug: platform.platformSlug,
  capabilityKey: platform.capabilityKey,
  capabilityLabel: platform.capabilityLabel,
  brief: 'how to batch shoot a week of content',
}

describe('template composer', () => {
  it('builds a draft from a prepared structure and says so', () => {
    const template = seedTemplateFor(platform)
    const draft = composeDraft(request, [template])

    assert.equal(draft.source, 'TEMPLATE')
    assert.equal(draft.templateId, template.id)
    assert.match(draft.provenance, /prepared structure/i)
    assert.match(draft.body, /batch shoot a week of content/)
    assert.match(draft.hook, /First line earns the next three seconds/i)
    assert.ok(draft.cta.length > 0)
  })

  it('is honest when no prepared structure exists', () => {
    const draft = composeDraft({ ...request, capabilityKey: 'POLL', capabilityLabel: 'Poll' }, [])
    assert.equal(draft.source, 'NONE')
    assert.equal(draft.templateName, null)
    assert.match(draft.provenance, /No prepared template/i)
    assert.ok(draft.notes.some((note) => /do not have a prepared structure/i.test(note)))
  })

  it('ignores templates from another platform or another option', () => {
    const other = seedTemplateFor({ ...platform, platformId: 'pf_other' })
    const draft = composeDraft(request, [other])
    assert.equal(draft.source, 'NONE')
  })

  it('ignores retired templates', () => {
    const template: TemplateDefinition = { ...seedTemplateFor(platform), status: 'RETIRED' }
    assert.equal(composeDraft(request, [template]).source, 'NONE')
  })

  it('is deterministic for the same input', () => {
    const template = seedTemplateFor(platform)
    assert.equal(composeDraft(request, [template]).body, composeDraft(request, [template]).body)
  })

  it('gives different structures to different formats', () => {
    const video = seedTemplateFor(platform)
    const text = seedTemplateFor({ ...platform, capabilityKey: 'TEXT_POST', capabilityLabel: 'Text post' })
    const carousel = seedTemplateFor({ ...platform, capabilityKey: 'CAROUSEL', capabilityLabel: 'Carousel' })

    assert.match(video.structure, /Hook/)
    assert.match(text.structure, /Claim/)
    assert.match(carousel.structure, /Card 1/)
    assert.notEqual(video.hook, text.hook)
  })

  it('sanitises the brief instead of trusting it', () => {
    const draft = composeDraft({ ...request, brief: `  spaced\n\nout ${'x'.repeat(400)}  ` }, [seedTemplateFor(platform)])
    assert.ok(draft.body.length < 700)
    assert.ok(!draft.body.includes('  '))
  })
})
