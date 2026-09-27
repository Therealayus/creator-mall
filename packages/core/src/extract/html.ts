import type { FetchedDocument } from '../types/source.js'

/**
 * A deliberately small, dependency-free HTML reader.
 *
 * Scope: research needs titles, headings, links and text. It does not need a
 * browser, and it must never execute page scripts. Unknown tags are dropped,
 * known text tags are kept, and nothing is evaluated.
 */
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
])

const SKIP_CONTENT_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'head'])

const BLOCK_TAGS = new Set([
  'p',
  'div',
  'section',
  'article',
  'li',
  'tr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'pre',
])

export function htmlToText(html: string): string {
  let out = ''
  let skipDepth = 0
  // Comments carry no platform facts and are the cheapest way to hide text from
  // a human reader while it still reaches the model, so they go first.
  html = html.replace(/<!--[\s\S]*?-->/g, ' ')
  const tagPattern = /<\/?([a-zA-Z0-9-]+)([^>]*)>/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = tagPattern.exec(html)) !== null) {
    const [full, rawName, rawAttrs] = match
    const name = (rawName ?? '').toLowerCase()
    const attrs = rawAttrs ?? ''
    const closing = full.startsWith('</')

    // Text always precedes its tag, so capture it before deciding to skip.
    const text = html.slice(lastIndex, match.index)
    if (skipDepth === 0 && text.trim()) out += `${text} `
    lastIndex = tagPattern.lastIndex

    if (SKIP_CONTENT_TAGS.has(name)) {
      if (closing) skipDepth = Math.max(0, skipDepth - 1)
      else if (!attrs.trimEnd().endsWith('/')) skipDepth += 1
      continue
    }
    if (skipDepth > 0) continue

    if (name === 'br' || VOID_TAGS.has(name)) continue
    if (BLOCK_TAGS.has(name)) out += '\n'
  }

  const tail = html.slice(lastIndex)
  if (!skipDepth && tail.trim()) out += `${tail} `

  return collapseWhitespace(out)
}

export function extractTitle(html: string): string | null {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (title?.[1]) return collapseWhitespace(stripTags(title[1]))
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html)
  if (og?.[1]) return collapseWhitespace(og[1])
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)
  if (h1?.[1]) return collapseWhitespace(stripTags(h1[1]))
  return null
}

export function extractHeadings(html: string): string[] {
  const headings: string[] = []
  const pattern = /<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null) {
    const text = collapseWhitespace(stripTags(match[2] ?? ''))
    if (text) headings.push(text)
  }
  return headings
}

export function extractLinks(html: string, baseUrl: string): string[] {
  const links: string[] = []
  const pattern = /<a[^>]+href=["']([^"']+)["']/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null) {
    const href = match[1]
    if (!href) continue
    try {
      const resolved = new URL(href, baseUrl)
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue
      links.push(resolved.toString())
    } catch {
      // ignore unparsable hrefs
    }
  }
  return [...new Set(links)]
}

export function parseDocument(
  body: string,
  url: string,
  contentType: string,
  fetchedAt: string,
): FetchedDocument {
  const isHtml = /html|xml/i.test(contentType) || /^\s*<!doctype html/i.test(body)
  if (!isHtml) {
    return {
      url,
      finalUrl: url,
      title: null,
      text: collapseWhitespace(body),
      links: [],
      headings: [],
      contentType,
      fetchedAt,
    }
  }
  return {
    url,
    finalUrl: url,
    title: extractTitle(body),
    text: htmlToText(body),
    links: extractLinks(body, url),
    headings: extractHeadings(body),
    contentType,
    fetchedAt,
  }
}

/** Line-level diff used to show *what* text moved, not just "it changed". */
export interface TextHunk {
  kind: 'ADDED' | 'REMOVED'
  text: string
}

export function diffText(before: string, after: string): TextHunk[] {
  const a = before.split('\n').map((line) => line.trim()).filter(Boolean)
  const b = after.split('\n').map((line) => line.trim()).filter(Boolean)
  const setA = new Set(a)
  const setB = new Set(b)
  const hunks: TextHunk[] = []
  for (const line of a) if (!setB.has(line)) hunks.push({ kind: 'REMOVED', text: line })
  for (const line of b) if (!setA.has(line)) hunks.push({ kind: 'ADDED', text: line })
  return hunks
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, ' ')
}

function collapseWhitespace(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
