import type { AdapterContentInput, AdapterValidationIssue, PlatformState } from '@creator-mall/core'

/**
 * Validation shared by every adapter, driven by the verified limits in a
 * platform snapshot rather than by platform-specific code.
 */

export function numericLimits(limits: Record<string, unknown>, prefix = 'limits'): Array<{ path: string; value: number }> {
  const result: Array<{ path: string; value: number }> = []
  for (const [key, value] of Object.entries(limits)) {
    const path = `${prefix}.${key}`
    if (typeof value === 'number' && Number.isFinite(value)) {
      result.push({ path, value })
      continue
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      result.push(...numericLimits(value as Record<string, unknown>, path))
    }
  }
  return result
}

export function jsonValue(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

/**
 * Checks a draft against what we have actually verified.
 *
 * Returns errors for things that would be rejected, and a warning when we have
 * no verified limits at all — silence would read as permission.
 */
export function validationIssues(
  platformSlug: string,
  input: AdapterContentInput,
  state: PlatformState | null,
  declaredCapabilityKeys: readonly string[] = [],
): { valid: boolean; issues: AdapterValidationIssue[] } {
  const issues: AdapterValidationIssue[] = []
  const key = input.contentType.toUpperCase()
  const observation = state?.capabilities[key]
  // A capability the platform declares counts as supported until something
  // verified says otherwise — the same rule the creation UI uses.
  const declared = declaredCapabilityKeys.map((entry) => entry.toUpperCase()).includes(key)

  if (!observation && !declared) {
    issues.push({
      path: 'contentType',
      message: `We have not confirmed that ${platformSlug} supports this kind of post.`,
      severity: 'ERROR',
      sourceId: null,
    })
    return { valid: false, issues }
  }

  if (observation && (observation.state === 'DEPRECATED' || observation.state === 'REMOVED')) {
    issues.push({
      path: 'contentType',
      message: `${platformSlug} no longer supports this kind of post.`,
      severity: 'ERROR',
      sourceId: observation?.sourceIds[0] ?? null,
    })
  }

  const limits = state ? numericLimits(state.limits) : []
  for (const limit of limits) {
    if (/character/i.test(limit.path)) {
      const length = input.text?.length ?? 0
      if (length > limit.value) {
        issues.push({
          path: limit.path,
          message: `This is ${length} characters; ${platformSlug} allows ${limit.value}.`,
          severity: 'ERROR',
          sourceId: observation?.sourceIds[0] ?? null,
        })
      }
    }
    if (/hashtag/i.test(limit.path)) {
      const hashtags = (input.text?.match(/#\w+/g) ?? []).length
      if (hashtags > limit.value) {
        issues.push({
          path: limit.path,
          message: `This uses ${hashtags} hashtags; ${platformSlug} allows ${limit.value}.`,
          severity: 'ERROR',
          sourceId: observation?.sourceIds[0] ?? null,
        })
      }
    }
    if (/maximages/i.test(limit.path) && input.mediaRefs.length > limit.value) {
      issues.push({
        path: limit.path,
        message: `This has ${input.mediaRefs.length} files; ${platformSlug} allows ${limit.value}.`,
        severity: 'ERROR',
        sourceId: observation?.sourceIds[0] ?? null,
      })
    }
  }

  if (issues.length === 0 && limits.length === 0) {
    issues.push({
      path: 'limits',
      message: `We have not confirmed ${platformSlug}'s exact limits for this option yet.`,
      severity: 'WARNING',
      sourceId: observation?.sourceIds[0] ?? null,
    })
  }

  return { valid: issues.every((issue) => issue.severity !== 'ERROR'), issues }
}
