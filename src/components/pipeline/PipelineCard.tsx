import { useState, useRef, useEffect } from 'react'
import { toast } from 'sonner'
import { getBlockTypeIcon } from '../../utils/blockTypeIcons'
import type { Pipeline, PipelineNode, BlockType } from '../../types'

interface PipelineCardProps {
  pipeline: Pipeline
  blockTypeMap?: Map<string, string>
  onRun: (pipeline: Pipeline) => void
  onEdit: (pipeline: Pipeline) => void
  onDuplicate: (pipeline: Pipeline) => void
  onDelete: (pipeline: Pipeline) => void
  onPromote?: (pipeline: Pipeline) => void
}

// `pipeline.nodes` is array-insertion order, not execution order (nodes can be added to
// the canvas in any sequence) — walk it via `edges` so the icon row actually reflects the
// real start-to-finish flow. Linear-only pipelines (current MVP — see executor.ts's
// identical findStartNode/nextNode pattern), so each node has at most one outgoing edge.
function orderNodesByFlow(nodes: Pipeline['nodes'], edges: Pipeline['edges']): PipelineNode[] {
  const safeNodes = nodes ?? []
  const safeEdges = edges ?? []
  if (safeNodes.length === 0 || safeEdges.length === 0) return safeNodes

  const byId = new Map(safeNodes.map((n) => [n.id, n]))
  const hasIncoming = new Set(safeEdges.map((e) => e.targetNodeId))
  const start = safeNodes.find((n) => !hasIncoming.has(n.id)) ?? safeNodes[0]

  const ordered: PipelineNode[] = []
  const visited = new Set<string>()
  let current: PipelineNode | undefined = start
  while (current && !visited.has(current.id)) {
    ordered.push(current)
    visited.add(current.id)
    const outgoing = safeEdges.filter((e) => e.sourceNodeId === current!.id)
    const edge = outgoing.find((e) => e.isDefault) ?? outgoing[0]
    current = edge ? byId.get(edge.targetNodeId) : undefined
  }
  // Any node edges didn't reach (disconnected/orphaned) still needs to show up somewhere.
  for (const n of safeNodes) {
    if (!visited.has(n.id)) ordered.push(n)
  }
  return ordered
}

function MiniFlowPreview({ nodes, edges, blockMap }: { nodes: Pipeline['nodes']; edges?: Pipeline['edges']; blockMap?: Map<string, string> }) {
  const safeNodes = orderNodesByFlow(nodes, edges)
  const visible = safeNodes.slice(0, 6)
  const extra = safeNodes.length - 6

  if (safeNodes.length === 0) {
    return (
      <div style={{ fontSize: 11, color: 'var(--axon-t4)', fontStyle: 'italic', padding: '6px 0' }}>
        No nodes
      </div>
    )
  }

  const getNodeType = (node: any) => {
    // Prefer the block's CURRENT role from the live block map — node.type is cached at
    // node-creation time on the pipeline itself and never updated if the block's role
    // changes later (e.g. via block edit mode), so trusting it first was showing stale/
    // wrong icons. Only fall back to node.type if the block can't be found at all (e.g.
    // it was since deleted).
    if (blockMap && (node as any).blockId) {
      const fromBlock = blockMap.get((node as any).blockId)
      if (fromBlock) return fromBlock
    }
    return node.type || 'Execution'
  }

  const normalizedType = (type: string): BlockType => {
    const upper = type.toUpperCase()
    if (upper === 'IO') return 'IO'
    const titled = type.charAt(0).toUpperCase() + type.slice(1).toLowerCase()
    return titled as BlockType
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'nowrap', overflow: 'hidden', padding: '8px 0' }}>
      {visible.map((node, i) => {
        const nodeType = getNodeType(node)
        const blockType = normalizedType(nodeType)
        return (
          <span key={node.id} style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
            {i > 0 && (
              <svg width="14" height="12" viewBox="0 0 14 12" style={{ flexShrink: 0, opacity: 0.5, color: 'var(--axon-t3)' }}>
                <line x1="0" y1="6" x2="10" y2="6" stroke="currentColor" strokeWidth="1" />
                <polyline points="8,3 12,6 8,9" fill="none" stroke="currentColor" strokeWidth="1" />
              </svg>
            )}
            <div
              title={(node as any).name || (node as any).label}
              style={{
                width: 24,
                height: 24,
                borderRadius: 4,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                background: 'rgba(100,116,139,0.08)',
                border: '1px solid rgba(100,116,139,0.15)',
              }}
            >
              <img
                src={getBlockTypeIcon(blockType)}
                alt={nodeType}
                style={{ width: 18, height: 18, borderRadius: 2 }}
              />
            </div>
          </span>
        )
      })}
      {extra > 0 && (
        <span style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
          <svg width="14" height="12" viewBox="0 0 14 12" style={{ flexShrink: 0, opacity: 0.5, color: 'var(--axon-t3)' }}>
            <line x1="0" y1="6" x2="10" y2="6" stroke="currentColor" strokeWidth="1" />
            <polyline points="8,3 12,6 8,9" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
          <span style={{ fontSize: 10, color: 'var(--axon-t3)', flexShrink: 0, fontWeight: 600, background: 'rgba(100,116,139,0.08)', padding: '2px 6px', borderRadius: 3, border: '1px solid rgba(100,116,139,0.15)' }}>
            +{extra}
          </span>
        </span>
      )}
    </div>
  )
}

function relativeDate(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  const weeks = Math.floor(days / 7)

  if (days === 0) return 'Today'
  if (days === 1) return '1 day ago'
  if (days < 7) return `${days} days ago`
  if (weeks === 1) return '1 week ago'
  if (weeks < 5) return `${weeks} weeks ago`
  return `${Math.floor(weeks / 4)} months ago`
}

function initials(name: string | undefined | null) {
  return (name ?? '?').slice(0, 2).toUpperCase()
}

export default function PipelineCard({ pipeline, blockTypeMap, onRun, onEdit, onDuplicate, onDelete, onPromote }: PipelineCardProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [hovered, setHovered] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const tags = pipeline.tags ?? []
  const visibleTags = tags.slice(0, 4)
  const extraTags = tags.length - 4

  useEffect(() => {
    if (!menuOpen) return
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [menuOpen])

  function handleDelete() {
    setConfirmDelete(false)
    setMenuOpen(false)
    onDelete(pipeline)
  }

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: 'var(--axon-bg2)',
        border: `1px solid ${hovered ? 'var(--axon-border2, var(--axon-border))' : 'var(--axon-border)'}`,
        borderRadius: 10,
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        transition: 'border-color 0.15s, box-shadow 0.15s',
        boxShadow: hovered ? '0 4px 16px rgba(0,0,0,0.3)' : '0 1px 4px rgba(0,0,0,0.15)',
        position: 'relative',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--axon-t1)', lineHeight: 1.3 }}>
          {pipeline.name}
        </span>
        <div style={{ display: 'flex', gap: 6 }}>
          {pipeline.ownerTeam && (
            <span style={{
              fontSize: 10, fontWeight: 600, borderRadius: 4, padding: '2px 7px',
              flexShrink: 0, background: 'rgba(34,211,184,0.12)', color: '#22d3b8', border: '1px solid rgba(34,211,184,0.25)'
            }}>
              {pipeline.ownerTeam}
            </span>
          )}
          <span style={{
            fontSize: 10, fontWeight: 600, borderRadius: 4, padding: '2px 7px',
            flexShrink: 0,
            ...(pipeline.isActive
              ? { background: 'rgba(111,95,232,0.15)', color: '#a78bfa', border: '1px solid rgba(111,95,232,0.3)' }
              : { background: 'rgba(100,116,139,0.12)', color: 'var(--axon-t3)', border: '1px solid rgba(100,116,139,0.2)' })
          }}>
            {pipeline.isActive ? 'Active' : 'Draft'}
          </span>
        </div>
      </div>

      {/* Description */}
      {pipeline.description && (
        <p style={{
          fontSize: 12, color: 'var(--axon-t2)', margin: 0, lineHeight: 1.5,
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
        }}>
          {pipeline.description}
        </p>
      )}

      {/* Tags */}
      {visibleTags.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {visibleTags.map(tag => (
            <span key={tag} style={{
              fontSize: 10, padding: '2px 6px', borderRadius: 4,
              background: 'rgba(100,116,139,0.1)', color: 'var(--axon-t3)',
              border: '1px solid rgba(100,116,139,0.15)',
            }}>
              {tag}
            </span>
          ))}
          {extraTags > 0 && (
            <span style={{ fontSize: 10, color: 'var(--axon-t4)', padding: '2px 4px' }}>
              +{extraTags} more
            </span>
          )}
        </div>
      )}

      {/* Mini flow preview */}
      <MiniFlowPreview nodes={pipeline.nodes ?? []} edges={pipeline.edges ?? []} blockMap={blockTypeMap} />

      {/* Stats */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: 'var(--axon-t3)' }}>{pipeline.nodeCount ?? (pipeline.nodes ?? []).length} blocks</span>
        <span style={{ fontSize: 11, color: 'var(--axon-t3)' }}>v{pipeline.version ?? '1'}</span>
        <span style={{ fontSize: 11, color: 'var(--axon-t3)' }}>{relativeDate(pipeline.updatedAt ?? pipeline.createdAt)}</span>
        {pipeline.createdByName && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto', fontSize: 11 }}>
            <div style={{
              width: 18, height: 18, borderRadius: '50%', background: 'rgba(111,95,232,0.2)',
              border: '1px solid rgba(111,95,232,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 8, fontWeight: 700, color: 'var(--axon-nexus2)',
            }}>
              {initials(pipeline.createdByName)}
            </div>
            <span style={{ color: 'var(--axon-t3)' }}>{pipeline.createdByName}</span>
          </div>
        )}
      </div>

      {/* Divider */}
      <div style={{ borderTop: '1px solid var(--axon-border)', margin: '0 -16px', padding: '0 16px' }} />

      {/* Actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: -2 }}>
        <button
          onClick={() => onRun(pipeline)}
          style={{
            background: 'var(--axon-nexus, #6f5fe8)', border: 'none', color: '#fff',
            borderRadius: 5, padding: '4px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer',
          }}
        >
          ▶ Run
        </button>
        <button
          onClick={() => onEdit(pipeline)}
          style={{
            background: 'none', border: '1px solid var(--axon-border)', color: 'var(--axon-t2)',
            borderRadius: 5, padding: '4px 10px', fontSize: 11, cursor: 'pointer',
          }}
        >
          ✎ Edit
        </button>
        <button
          onClick={() => onDuplicate(pipeline)}
          style={{
            background: 'none', border: '1px solid var(--axon-border)', color: 'var(--axon-t2)',
            borderRadius: 5, padding: '4px 10px', fontSize: 11, cursor: 'pointer',
          }}
        >
          ⧉ Duplicate
        </button>

        {/* More menu */}
        <div ref={menuRef} style={{ marginLeft: 'auto', position: 'relative' }}>
          <button
            onClick={() => setMenuOpen(o => !o)}
            style={{
              background: 'none', border: '1px solid var(--axon-border)', color: 'var(--axon-t2)',
              borderRadius: 5, padding: '4px 8px', fontSize: 13, cursor: 'pointer', lineHeight: 1,
            }}
          >
            ⋯
          </button>
          {menuOpen && (
            <div style={{
              position: 'absolute', right: 0, bottom: '110%', zIndex: 50,
              background: 'var(--axon-bg2)', border: '1px solid var(--axon-border)',
              borderRadius: 7, minWidth: 160, padding: '4px 0',
              boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            }}>
              <button
                onClick={() => { toast.info('Rename coming soon'); setMenuOpen(false) }}
                style={menuItemStyle}
              >
                Rename
              </button>
              <button
                onClick={() => { toast.info('Export coming soon'); setMenuOpen(false) }}
                style={menuItemStyle}
              >
                Export as JSON
              </button>
              <div style={{ borderTop: '1px solid var(--axon-border)', margin: '4px 0' }} />
              <button
                onClick={() => { onPromote?.(pipeline); setMenuOpen(false) }}
                style={{ ...menuItemStyle, color: '#fbbf24' }}
                title="Coming soon"
              >
                Request Org Promotion
              </button>
              <div style={{ borderTop: '1px solid var(--axon-border)', margin: '4px 0' }} />
              <button
                onClick={() => { setConfirmDelete(true); setMenuOpen(false) }}
                style={{ ...menuItemStyle, color: '#f87171' }}
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Delete confirm dialog */}
      {confirmDelete && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 100,
            background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onClick={() => setConfirmDelete(false)}
        >
          <div
            style={{
              background: 'var(--axon-bg2)', border: '1px solid var(--axon-border)',
              borderRadius: 10, padding: 24, maxWidth: 360, width: '90%',
              boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
            }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--axon-t1)', marginBottom: 8 }}>
              Delete "{pipeline.name}"?
            </div>
            <div style={{ fontSize: 13, color: 'var(--axon-t2)', marginBottom: 20 }}>
              This cannot be undone.
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setConfirmDelete(false)}
                style={{
                  background: 'none', border: '1px solid var(--axon-border)', color: 'var(--axon-t2)',
                  borderRadius: 6, padding: '6px 14px', fontSize: 12, cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                style={{
                  background: '#ef4444', border: 'none', color: '#fff',
                  borderRadius: 6, padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const menuItemStyle: React.CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left',
  background: 'none', border: 'none', color: 'var(--axon-t1)',
  padding: '7px 14px', fontSize: 12, cursor: 'pointer',
}
