#!/usr/bin/env node
/**
 * Runs both test suites with the TypeScript settings each one needs.
 *
 * `packages/*` compiles as Node ESM (NodeNext, no JSX). `apps/web` is a browser
 * app, so its files need the bundler module resolution and the automatic JSX
 * runtime from its own tsconfig. Node expands the globs itself.
 */
import { spawn } from 'node:child_process'
import process from 'node:process'

const SUITES = [
  {
    name: 'packages',
    patterns: ['packages/*/test/**/*.test.ts'],
    env: {},
  },
  {
    name: 'web',
    patterns: ['apps/*/test/**/*.test.ts?(x)'],
    env: { TSX_TSCONFIG_PATH: 'apps/web/tsconfig.json' },
  },
]

function run(suite) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--test', ...suite.patterns],
      { stdio: 'inherit', env: { ...process.env, ...suite.env }, shell: false },
    )
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

let failed = false
for (const suite of SUITES) {
  console.log(`\n── ${suite.name} ──`)
  const code = await run(suite)
  if (code !== 0) failed = true
}

process.exit(failed ? 1 : 0)
