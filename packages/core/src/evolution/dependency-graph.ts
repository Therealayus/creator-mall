import type { DependencyEdge, DependencyNode, AffectedComponent } from '../types/evolution.js'
import type { DependencyKind } from '../types/enums.js'
import { canonicalJson, hashString } from '../util.js'

/**
 * §25: a machine-readable map of
 * Platform → Capability → Content type → Prompt → Template → Editor →
 * Publisher → Analytics.
 *
 * When one capability changes, the graph answers "what else is affected?"
 * without anyone maintaining a list by hand.
 */
export class DependencyGraph {
  private readonly nodes = new Map<string, DependencyNode>()
  private readonly edges = new Map<string, DependencyEdge>()

  addNode(node: DependencyNode): DependencyNode {
    this.nodes.set(nodeKey(node.kind, node.ref), node)
    return node
  }

  ensurePlatform(platformId: string, label: string): DependencyNode {
    return this.addNode({ kind: 'PLATFORM', ref: platformId, label })
  }

  ensureCapability(platformId: string, capabilityKey: string, label: string): DependencyNode {
    return this.addNode({ kind: 'CAPABILITY', ref: `${platformId}:${capabilityKey}`, label })
  }

  link(from: DependencyNode, to: DependencyNode, relation: DependencyEdge['relation']): void {
    this.addNode(from)
    this.addNode(to)
    const edge: DependencyEdge = { from, to, relation }
    this.edges.set(`${edgeKey(from, to, relation)}`, edge)
  }

  /** Declares the standard chain for a platform capability. */
  linkCapabilityChain(input: {
    platformId: string
    platformLabel: string
    capabilityKey: string
    capabilityLabel: string
    contentType?: string
    promptKey?: string
    templateId?: string
    editor?: string
    publisher?: string
    analytics?: string
    documentation?: string
  }): void {
    const platform = this.ensurePlatform(input.platformId, input.platformLabel)
    const capability = this.ensureCapability(input.platformId, input.capabilityKey, input.capabilityLabel)

    this.link(platform, capability, 'REQUIRES')

    const contentType = input.contentType
      ? this.addNode({ kind: 'CONTENT_TYPE', ref: `${input.platformId}:${input.contentType}`, label: input.contentType })
      : null
    if (contentType) this.link(capability, contentType, 'GENERATES')

    if (input.promptKey) {
      const prompt = this.addNode({ kind: 'AI_PROMPT', ref: input.promptKey, label: input.promptKey })
      this.link(contentType ?? capability, prompt, 'GENERATES')
    }
    if (input.templateId) {
      const template = this.addNode({ kind: 'TEMPLATE', ref: input.templateId, label: input.templateId })
      this.link(capability, template, 'GENERATES')
    }
    if (input.editor) {
      const editor = this.addNode({ kind: 'EDITOR', ref: input.editor, label: input.editor })
      this.link(capability, editor, 'CONSUMES')
    }
    if (input.publisher) {
      const publisher = this.addNode({ kind: 'PUBLISHER', ref: input.publisher, label: input.publisher })
      this.link(capability, publisher, 'CONSUMES')
    }
    if (input.analytics) {
      const analytics = this.addNode({ kind: 'ANALYTICS', ref: input.analytics, label: input.analytics })
      this.link(capability, analytics, 'CONSUMES')
    }
    if (input.documentation) {
      const docs = this.addNode({ kind: 'DOCUMENTATION', ref: input.documentation, label: input.documentation })
      this.link(capability, docs, 'CONSUMES')
    }
  }

  nodes_(): DependencyNode[] {
    return [...this.nodes.values()]
  }

  allEdges(): DependencyEdge[] {
    return [...this.edges.values()]
  }

  node(kind: DependencyKind, ref: string): DependencyNode | undefined {
    return this.nodes.get(nodeKey(kind, ref))
  }

  /** Direct neighbours in either direction, tagged with the edge relation. */
  neighbours(node: DependencyNode): AffectedComponent[] {
    const key = nodeKey(node.kind, node.ref)
    const result: AffectedComponent[] = []
    for (const edge of this.edges.values()) {
      if (nodeKey(edge.from.kind, edge.from.ref) === key) {
        result.push({ kind: edge.to.kind, ref: edge.to.ref, relation: edge.relation, depth: 1 })
      }
      if (nodeKey(edge.to.kind, edge.to.ref) === key) {
        result.push({ kind: edge.from.kind, ref: edge.from.ref, relation: edge.relation, depth: 1 })
      }
    }
    return dedupe(result)
  }

  /**
   * Breadth-first blast radius around a set of seed nodes. Upstream consumers
   * (who needs this?) and downstream producers (what does this need?).
   */
  blastRadius(seeds: ReadonlyArray<DependencyNode>, maxDepth = 4): AffectedComponent[] {
    const visited = new Set<string>()
    const result: AffectedComponent[] = []
    let frontier = [...seeds]

    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
      const next: DependencyNode[] = []
      for (const node of frontier) {
        for (const component of this.neighbours(node)) {
          const key = nodeKey(component.kind, component.ref)
          if (visited.has(key)) continue
          visited.add(key)
          result.push({ ...component, depth })
          next.push({ kind: component.kind, ref: component.ref, label: component.ref })
        }
      }
      frontier = next
    }
    return result
  }

  impactOfCapability(platformId: string, capabilityKey: string): AffectedComponent[] {
    const node = this.node('CAPABILITY', `${platformId}:${capabilityKey}`)
    if (!node) return []
    return this.blastRadius([node])
  }

  impactOfPlatform(platformId: string): AffectedComponent[] {
    const node = this.node('PLATFORM', platformId)
    if (!node) return []
    return this.blastRadius([node], 5)
  }

  toJSON(): DependencyEdge[] {
    return this.allEdges()
  }

  static fromEdges(edges: ReadonlyArray<DependencyEdge>): DependencyGraph {
    const graph = new DependencyGraph()
    for (const edge of edges) {
      graph.addNode(edge.from)
      graph.addNode(edge.to)
      graph.link(edge.from, edge.to, edge.relation)
    }
    return graph
  }

  /** Stable identity for change detection on the graph itself. */
  hash(): string {
    return hashString(canonicalJson(this.allEdges()))
  }
}

function nodeKey(kind: DependencyKind, ref: string): string {
  return `${kind}:${ref}`
}

function edgeKey(from: DependencyNode, to: DependencyNode, relation: DependencyEdge['relation']): string {
  return `${nodeKey(from.kind, from.ref)}->${nodeKey(to.kind, to.ref)}:${relation}`
}

function dedupe(components: AffectedComponent[]): AffectedComponent[] {
  const seen = new Set<string>()
  const result: AffectedComponent[] = []
  for (const component of components) {
    const key = `${component.kind}:${component.ref}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(component)
  }
  return result
}
