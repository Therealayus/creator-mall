const base = process.env.SMOKE_BASE ?? 'http://127.0.0.1:4130'

const get = async (path, init) => {
  const response = await fetch(base + path, init)
  return { status: response.status, contentType: response.headers.get('content-type') ?? '', body: await response.text() }
}

const rootMarker = 'id="root"'

const run = async () => {
  const spa = await get('/')
  console.log('SPA / ->', spa.status, spa.contentType.split(';')[0], '| has root div:', spa.body.includes(rootMarker))

  const deep = await get('/platforms/instagram')
  console.log('SPA deep link ->', deep.status, '| serves app:', deep.body.includes(rootMarker))

  const assetMatch = /\/assets\/index-[^"']+\.js/.exec(spa.body)
  if (assetMatch) {
    const asset = await get(assetMatch[0])
    console.log('asset ->', asset.status, asset.contentType.split(';')[0])
  }

  const overview = JSON.parse((await get('/api/creator/overview')).body)
  console.log(
    'overview: creator=%s platforms=%d optionsReady=%d updates=%d comingSoon=%d',
    overview.creator.name,
    overview.platforms.length,
    overview.counts.optionsReady,
    overview.updates.length,
    overview.comingSoon.length,
  )

  const instagram = overview.platforms.find((entry) => entry.slug === 'instagram')
  const enabled = instagram.options.filter((option) => option.enabled).map((option) => option.key)
  const disabled = instagram.options.filter((option) => !option.enabled).map((option) => option.key)
  console.log('instagram enabled:', enabled.join(', '))
  console.log('instagram unavailable:', disabled.join(', '), '| reason:', instagram.options.find((o) => !o.enabled)?.unavailableReason)

  const shortVideo = instagram.options.find((option) => option.key === 'SHORT_VIDEO')
  console.log('short video limits:', JSON.stringify(shortVideo.limits), '| media:', shortVideo.media)

  const draft = JSON.parse(
    (
      await get('/api/creator/draft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'instagram', option: 'SHORT_VIDEO', brief: 'batch filming a week' }),
      })
    ).body,
  )
  console.log('draft prepared=%s publishing=%s | %s', draft.prepared, draft.publishing, draft.provenance)

  const validation = JSON.parse(
    (
      await get('/api/creator/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'instagram', option: 'SHORT_VIDEO', text: 'hello', mediaCount: 1 }),
      })
    ).body,
  )
  console.log('validation valid=%s issues=%d', validation.valid, validation.issues.length)

  const why = JSON.parse((await get('/api/creator/platforms/instagram/why?option=SHORT_VIDEO')).body)
  console.log('why available=%s from=%s', why.available, why.from)

  const center = await get('/evolution-center')
  console.log('evolution center ->', center.status, 'bytes', center.body.length)
}

run().catch((error) => {
  console.error('SMOKE FAILED', error)
  process.exit(1)
})
