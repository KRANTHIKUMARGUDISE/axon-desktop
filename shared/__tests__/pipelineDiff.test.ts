import { describe, it, expect } from 'vitest'
import { diffPipelines } from '../pipelineDiff'
import type { PipelineSide } from '../pipelineDiff'

const node = (id: string, blockId: string, over: Record<string, unknown> = {}) => ({ id, blockId, position: { x: 0, y: 0 }, ...over }) as never
const edge = (s: string, t: string) => ({ id: `${s}-${t}`, sourceNodeId: s, targetNodeId: t }) as never
const names: Record<string, string> = { plan: 'Demo Planner', gate: 'Human Gate', ju: 'Jira Update', pr: 'PR Creator' }
const opts = { blockName: (id: string) => names[id] ?? id }

const v1: PipelineSide = {
  version: 1,
  nodes: [node('a', 'plan', { blockVersion: 2 }), node('g', 'gate', { config: { reason: 'old', mode: 'Pause', checklist: ['x'] } }), node('p', 'pr')],
  edges: [edge('a', 'g'), edge('g', 'p')],
}
const v2: PipelineSide = {
  version: 2, versionLabel: 'Review round', changeNote: 'Notify instead of pause',
  nodes: [
    node('a', 'plan', { blockVersion: 3 }),
    node('g', 'gate', { config: { reason: 'new reason', mode: 'NotifyOnly', checklist: ['x', 'y'] } }),
    node('p', 'pr'),
    node('j', 'ju', { label: 'Mark in review', config: { transition: 'In Review', addLabels: ['review-me'] } }),
  ],
  edges: [edge('a', 'g'), edge('g', 'p'), edge('p', 'j')],
}

describe('pipeline diff', () => {
  it('lists added, removed and changed parts in plain words', () => {
    const d = diffPipelines(v1, v2, opts)
    expect(d).toMatchObject({ from: 1, to: 2, versionLabel: 'Review round', changeNote: 'Notify instead of pause' })
    const text = d.items.map((i) => `${i.kind}: ${i.text}`)
    expect(text).toContain('added: Added Jira Update (“Mark in review”)')
    expect(text).toContain('added: Connected PR Creator → Mark in review')
    expect(text).toContain('changed: “a”: Demo Planner v2 → v3'.replace('“a”', '“Demo Planner”'))
    expect(text).toContain('changed: “Human Gate”: mode: Pause → NotifyOnly')
    expect(text).toContain('changed: “Human Gate”: review reason changed')
    expect(text).toContain('changed: “Human Gate”: review checklist: + y')
    // added comes before changed
    expect(d.items[0].kind).toBe('added')
  })

  it('reports removals, reconnections and failure actions', () => {
    const d = diffPipelines(v2, v1, opts)
    expect(d.items.map((i) => i.text)).toEqual(expect.arrayContaining(['Removed Jira Update (“Mark in review”)', 'Disconnected PR Creator → Mark in review']))
    const f = diffPipelines({ ...v1 }, { ...v1, version: 3, onFailure: [{ kind: 'jira-update', addLabels: ['x'], removeLabels: [] }], onFailureOnCancel: true }, opts)
    expect(f.items.map((i) => i.text)).toEqual(expect.arrayContaining(['“When the pipeline fails” actions: 0 → 1', 'Failure actions on cancel: now run']))
  })

  it('says nothing for identical versions and describes the effect on Jira', () => {
    expect(diffPipelines(v1, { ...v1, version: 2 }, opts).items).toEqual([])
    const eff = (o: object) => ({ addLabels: [], removeLabels: [], transitions: [], hasGate: false, ...o })
    const d = diffPipelines(v1, v2, { ...opts, effects: { from: eff({ hasGate: true }), to: eff({ transitions: ['In Review'], addLabels: ['review-me'] }) } })
    expect(d.ruleEffect).toEqual(['Now moves the ticket to status In Review', 'Now adds the label review-me', 'No longer pauses for a Human Gate'])
  })
});
