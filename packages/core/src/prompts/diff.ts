export interface LineDiff {
  added: string[]
  removed: string[]
}

/** Minimal line diff used to preview prompt and knowledge version changes. */
export function diffLines(before: string, after: string): string {
  const { added, removed } = lineDiff(before, after)
  return [...removed.map((line) => `- ${line}`), ...added.map((line) => `+ ${line}`)].join('\n')
}

export function lineDiff(before: string, after: string): LineDiff {
  const a = before.split('\n')
  const b = after.split('\n')
  const setA = new Set(a)
  const setB = new Set(b)
  return {
    removed: a.filter((line) => line.trim() && !setB.has(line)),
    added: b.filter((line) => line.trim() && !setA.has(line)),
  }
}
