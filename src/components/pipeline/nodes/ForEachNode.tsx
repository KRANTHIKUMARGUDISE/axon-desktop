import type React from 'react'
import { Handle, NodeResizer, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'

// ForEach is a pipeline node type, not a block (D14): a resizable container. Child nodes carry its id
// as `parentId`; the container's own handles connect it to the rest of the flow.

const COLOR = '#a78bfa'

const handleStyle: React.CSSProperties = { background: COLOR, width: 8, height: 8, border: '2px solid #0f1117' }

export interface ForEachNodeData {
  label: string
  /** Name of the block whose work-item list this ForEach iterates (its single predecessor). */
  sourceLabel?: string | null
  maxItems?: number
  hideHandles?: boolean
  // Live View only: "2 of 4 · refunds-api" and the lanes rendered under the header.
  counter?: string
  executionStatus?: 'Pending' | 'Running' | 'Success' | 'Failed' | 'AwaitingApproval'
  lanes?: React.ReactNode
  resizable?: boolean
}

const STATUS_COLORS: Record<string, string> = {
  Pending: '#64748b', Running: '#3b82f6', Success: '#22c55e', Failed: '#ef4444', AwaitingApproval: '#f59e0b',
}

export default function ForEachNode({ data, selected }: NodeProps) {
  const d = data as unknown as ForEachNodeData
  const status = d.executionStatus ? STATUS_COLORS[d.executionStatus] : undefined
  const border = status ?? (selected ? COLOR : `${COLOR}88`)
  const hidden = d.hideHandles ? { opacity: 0, pointerEvents: 'none' as const } : {}
  return (
    <div
      style={{
        width: '100%', height: '100%', minWidth: 240, minHeight: 140, boxSizing: 'border-box',
        background: '#a78bfa0d', border: `1.5px dashed ${border}`, borderRadius: 10, position: 'relative',
        boxShadow: status ? `0 0 0 2px ${status}44` : undefined,
      }}
    >
      {d.resizable !== false && <NodeResizer isVisible={selected} minWidth={240} minHeight={140} lineStyle={{ borderColor: COLOR }} handleStyle={{ background: COLOR, width: 8, height: 8 }} />}
      <Handle type="target" position={Position.Left} id="left" style={{ ...handleStyle, ...hidden }} />
      <Handle type="target" position={Position.Top} id="top" style={{ ...handleStyle, ...hidden }} />
      <Handle type="source" position={Position.Bottom} id="bottom" style={{ ...handleStyle, ...hidden }} />
      <Handle type="source" position={Position.Right} id="right" style={{ ...handleStyle, ...hidden }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: `1px dashed ${COLOR}33`, minWidth: 0 }}>
        <span title="ForEach" style={{ color: COLOR, fontSize: 14, lineHeight: 1, flexShrink: 0 }}>⟳</span>
        <span title={d.label} style={{ fontSize: 12, fontWeight: 700, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{d.label}</span>
        {d.counter && <span style={{ marginLeft: 'auto', flexShrink: 0, fontSize: 11, color: status ?? '#94a3b8', fontWeight: 600, whiteSpace: 'nowrap' }}>{d.counter}</span>}
      </div>
      <div
        title={d.sourceLabel ? `Runs once per item from ${d.sourceLabel} (max ${d.maxItems ?? 10} items)` : undefined}
        style={{ padding: '3px 10px', fontSize: 10, color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {d.sourceLabel ? <>Runs once per item from <b style={{ color: '#a78bfa' }}>{d.sourceLabel}</b></> : 'Connect a block that returns a work-item list.'}
      </div>
      {/* Item chips sit under the container (never over the body nodes) and scroll sideways when there are many. */}
      {d.lanes && <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 6 }}>{d.lanes}</div>}
    </div>
  )
}
