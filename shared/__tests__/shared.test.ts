import { describe, it, expect } from 'vitest'
import {
  resolvePipelineProgress, validatePipelineGraph, findStartNode, nextNode,
  shortId, safeSegment, slugify, DeliverySchema, BlockSchema,
} from '../index'
import type { PipelineEdge, PipelineNode } from '../index'
import { deliveryBranchName } from '../../electron/workspace/gitWorkspace'

const node = (id: string): PipelineNode => ({ id, label: id, blockId: `b-${id}`, position: { x: 0, y: 0 } })
const edge = (s: string, t: string, extra: Partial<PipelineEdge> = {}): PipelineEdge => ({ id: `${s}-${t}`, sourceNodeId: s, targetNodeId: t, ...extra })

describe('graph helpers', () => {
  const nodes = [node('a'), node('b'), node('c')]
  const edges = [edge('a', 'b'), edge('b', 'c')]

  it('finds the start node and walks edges', () => {
    expect(findStartNode(nodes, edges)!.id).toBe('a')
    expect(nextNode('a', nodes, edges)!.id).toBe('b')
    expect(nextNode('c', nodes, edges)).toBeUndefined()
  })

  it('prefers the default edge when a node branches', () => {
    const e = [edge('a', 'b'), edge('a', 'c', { isDefault: true })]
    expect(nextNode('a', nodes, e)!.id).toBe('c')
  })

  it('resume walk stops at the first node without a Completed step', () => {
    const r = resolvePipelineProgress(nodes, edges, [{ nodeId: 'a', status: 'Completed' }, { nodeId: 'b', status: 'Failed' }])
    expect(r.lastCompletedNode!.id).toBe('a')
    expect(r.resumeNode!.id).toBe('b')
  })

  it('resume walk terminates on a cycle instead of spinning forever', () => {
    const cyclic = [edge('a', 'b'), edge('b', 'c'), edge('c', 'b')]
    const steps = ['a', 'b', 'c'].map((id) => ({ nodeId: id, status: 'Completed' as const }))
    const r = resolvePipelineProgress(nodes, cyclic, steps)
    expect(r.resumeNode).toBeUndefined()
    expect(r.lastCompletedNode!.id).toBe('c')
  })

  it('reports no resume node when everything completed', () => {
    const steps = nodes.map((n) => ({ nodeId: n.id, status: 'Completed' as const }))
    expect(resolvePipelineProgress(nodes, edges, steps).resumeNode).toBeUndefined()
  })
})

describe('validatePipelineGraph', () => {
  it('accepts a simple chain', () => {
    expect(validatePipelineGraph([node('a'), node('b')], [edge('a', 'b')]).valid).toBe(true)
  })
  it('flags empty pipelines, cycles, dangling edges and missing default routes', () => {
    expect(validatePipelineGraph([], []).errors[0]).toMatch(/no nodes/)
    expect(validatePipelineGraph([node('a'), node('b'), node('c')], [edge('a', 'b'), edge('b', 'c'), edge('c', 'b')]).errors.join()).toMatch(/cycle/)
    expect(validatePipelineGraph([node('a')], [edge('a', 'zzz')]).errors.join()).toMatch(/missing node/)
    expect(validatePipelineGraph([node('a'), node('b'), node('c')], [edge('a', 'b'), edge('a', 'c')]).errors.join()).toMatch(/default route/)
  })
  it('flags unknown blocks when a block map is supplied', () => {
    const res = validatePipelineGraph([node('a')], [], new Map())
    expect(res.errors.join()).toMatch(/unknown block/)
  })
})

describe('ids and branch names (D1)', () => {
  it('shortId is a deterministic 6-char base32 string', () => {
    const id = '3f2b9c1e-aaaa-bbbb-cccc-1234567890ab'
    expect(shortId(id)).toMatch(/^[a-z2-7]{6}$/)
    expect(shortId(id)).toBe(shortId(id))
    expect(shortId(id)).not.toBe(shortId('00000001-aaaa-bbbb-cccc-1234567890ab'))
  })

  it('safeSegment neutralises path/ref hostile ticket ids', () => {
    expect(safeSegment('../../etc/passwd')).not.toContain('..')
    expect(safeSegment('PROJ 12/3')).toBe('PROJ-12-3')
    expect(safeSegment('///')).toBe('x')
    expect(slugify('Kranthi Kumar')).toBe('kranthi-kumar')
  })

  it('builds axon/{user}/{ticket}-{shortId} branch names', () => {
    const id = '3f2b9c1e-aaaa-bbbb-cccc-1234567890ab'
    expect(deliveryBranchName(id, 'PROJ-2341', 'Kranthi G')).toBe(`axon/kranthi-g/PROJ-2341-${shortId(id)}`)
  })
})

describe('schemas', () => {
  it('Block defaults and requires core fields', () => {
    const b = BlockSchema.parse({
      id: 'x', createdAt: 't', updatedAt: 't', name: 'n', role: 'Execution', sourceType: 'Local', agentRuntime: 'Claude', artifactFormat: 'Skill',
    })
    expect(b).toMatchObject({ schemaVersion: 2, version: 1, tags: [] })
    expect(() => BlockSchema.parse({ id: 'x' })).toThrow()
  })

  it('Delivery accepts the Interrupted status', () => {
    const base = {
      id: 'd', createdAt: 't', updatedAt: 't', localSeq: 1, ticketId: 'T', pipelineId: 'p', pipelineName: 'P',
      pipelineSnapshot: { pipelineId: 'p', pipelineVersion: 1, name: 'P', nodes: [], edges: [] }, startedAt: 't',
    }
    expect(DeliverySchema.parse({ ...base, status: 'Interrupted' }).status).toBe('Interrupted')
    expect(() => DeliverySchema.parse({ ...base, status: 'NeedsHuman' })).toThrow()
  })
})
