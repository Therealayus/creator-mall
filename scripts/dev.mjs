#!/usr/bin/env node
/**
 * Runs the API and the web dev server together, because the product is the two of
 * them: the app renders from the API, and the API is useless without the app.
 *
 * No dependency, no config file — just two child processes and clean shutdown.
 */
import { spawn } from 'node:child_process'
import process from 'node:process'

const TASKS = [
  { name: 'api', color: '[36m', command: 'npm', args: ['run', 'dev:server'] },
  { name: 'web', color: '[35m', command: 'npm', args: ['run', 'dev:web'] },
]

const RESET = '[0m'
const children = []
let shuttingDown = false

for (const task of TASKS) {
  const child = spawn(task.command, task.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // Local development runs with no operator token, and the admin API is
      // closed by default. Opt the dev processes in explicitly rather than
      // falling open: production never runs through this script, so the gate
      // stays shut everywhere else.
      ALLOW_UNAUTHENTICATED_ADMIN: process.env.ALLOW_UNAUTHENTICATED_ADMIN ?? 'true',
      // Local development keeps its state on disk, so restarting the app does
      // not wipe every account. Production sets DATA_DIR explicitly; this only
      // fills in the dev default. `data/` is gitignored.
      DATA_DIR: process.env.DATA_DIR ?? 'data',
    },
    shell: process.platform === 'win32',
  })

  const prefix = `${task.color}[${task.name}]${RESET} `
  const forward = (stream, target) => {
    stream.setEncoding('utf8')
    let buffer = ''
    stream.on('data', (chunk) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) target.write(`${prefix}${line}\n`)
    })
  }
  forward(child.stdout, process.stdout)
  forward(child.stderr, process.stderr)

  child.on('exit', (code) => {
    if (shuttingDown) return
    console.log(`${prefix}exited with code ${code ?? 0}; stopping the other process`)
    shutdown(code ?? 0)
  })

  children.push(child)
}

function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    if (!child.killed) child.kill()
  }
  process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

console.log('Creator Mall dev: api on http://127.0.0.1:4000, web on http://127.0.0.1:5173')
