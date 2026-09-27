/**
 * @creator-mall/core — the intelligence layer.
 *
 * Everything here is pure and side-effect free: given the same inputs it
 * produces the same decisions. The server owns all I/O (fetching, storage,
 * scheduling); this package owns the reasoning.
 */

export * from './types/enums.js'
export * from './types/platform.js'
export * from './types/source.js'
export * from './types/knowledge.js'
export * from './types/evolution.js'
export * from './types/adapter.js'
export * from './types/creator.js'
export * from './types/health.js'
export * from './util.js'

export * from './capabilities/registry.js'
export * from './capabilities/taxonomy.js'

export * from './diff/types.js'
export * from './diff/classify.js'
export * from './diff/snapshot-diff.js'

export * from './extract/html.js'
export * from './extract/facts.js'

export * from './verify/trust.js'
export * from './verify/verifier.js'

export * from './evolution/dependency-graph.js'
export * from './evolution/impact.js'
export * from './evolution/planner.js'
export * from './evolution/readiness.js'

export * from './ui/capability-config.js'
export * from './ui/limits.js'

export * from './knowledge/chunking.js'
export * from './knowledge/store.js'

export * from './prompts/diff.js'
export * from './prompts/versioning.js'

export * from './platform/bootstrap.js'

export * from './composer/draft.js'

export * from './health/report.js'
