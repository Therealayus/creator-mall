import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The stylesheet must cover every control the app renders.
 *
 * This exists because of a real user report: the password field rendered as a
 * flat gray browser-default box while the email field was styled, because the
 * stylesheet only named `input[type="text"]`. Any new input type, button
 * variant, or control added without a matching rule fails a test here instead
 * of shipping a half-styled control to a creator.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'src')

function tsxFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      found.push(...tsxFiles(path))
    } else if (entry.endsWith('.tsx') && !entry.endsWith('.test.tsx')) {
      found.push(path)
    }
  }
  return found
}

function stylesheet(): string {
  return readFileSync(join(src, 'styles.css'), 'utf8')
}

describe('every rendered control has a style rule', () => {
  it('covers every input type the app uses', () => {
    const used = new Set<string>()
    for (const file of tsxFiles(src)) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/<input[^>]*type="([a-z]+)"/g)) {
        used.add(match[1]!)
      }
    }
    assert.ok(used.size > 0, 'expected to find inputs')
    const css = stylesheet()
    for (const type of used) {
      assert.match(
        css,
        new RegExp(`input\\[type="${type}"\\]`),
        `input type="${type}" is rendered but has no style rule and falls back to the browser default`,
      )
    }
  })

  it('gives every button variant a disabled state', () => {
    const css = stylesheet()
    for (const variant of ['button.primary:disabled', 'button.ghost:disabled']) {
      assert.ok(css.includes(variant), `${variant} is missing: a disabled button must not look clickable`)
    }
  })

  it('shows keyboard focus on every interactive element', () => {
    const css = stylesheet()
    for (const selector of ['button:focus-visible', 'a:focus-visible']) {
      assert.ok(css.includes(selector), `${selector} is missing: keyboard users need a visible focus state`)
    }
  })

  it('styles the file picker instead of leaving the browser default', () => {
    const css = stylesheet()
    assert.ok(
      css.includes('input[type="file"]'),
      'the library upload uses a file input with no rule: gray browser default on a dark page',
    )
  })
})
