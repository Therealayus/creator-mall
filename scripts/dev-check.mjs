const marker = 'id="root"'

const check = async (base) => {
  const response = await fetch(base)
  return { status: response.status, body: await response.text() }
}

const run = async () => {
  const web = await check('http://localhost:5173/')
  console.log('web  /              ->', web.status, web.body.includes(marker) ? 'app shell served' : 'UNEXPECTED')

  const proxied = await fetch('http://localhost:5173/api/creator/overview')
  const overview = await proxied.json()
  console.log(
    'web  /api proxy     ->',
    proxied.status,
    overview.creator.name,
    '|',
    overview.counts.optionsReady,
    'options ready across',
    overview.platforms.length,
    'platforms',
  )

  const health = await fetch('http://127.0.0.1:4000/api/health')
  const report = await health.json()
  console.log('api  /api/health    ->', health.status, report.health.overall)

  const built = await check('http://127.0.0.1:4000/')
  console.log('api  / (built app)  ->', built.status, built.body.includes(marker) ? 'serves web build' : 'not built')
}

run().catch((error) => {
  console.error('FAIL', error.message)
  process.exit(1)
})
