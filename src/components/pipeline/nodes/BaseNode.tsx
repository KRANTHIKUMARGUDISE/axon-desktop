import type React from 'react'
import { Handle, Position } from '@xyflow/react'
import { getBlockTypeIcon } from '../../../utils/blockTypeIcons'
import { getRuntimeIcon, RUNTIME_LABELS } from '../../../utils/runtimeIcons'
import type { BlockType, AgentRuntime } from '../../../types'

const handleStyle = (color: string, hidden?: boolean): React.CSSProperties => ({
  background: color, width: 8, height: 8, border: '2px solid #0f1117',
  opacity: hidden ? 0 : 1, pointerEvents: hidden ? 'none' : undefined,
})

const TYPE_COLORS: Record<string, string> = {
  Decision:  '#ec4899',
  Execution: '#38bdf8',
  Knowledge: '#22d3b8',
  Control:   '#f59e0b',
  Utility:   '#9b87f5',
  IO:        '#10b981',
}

export type ExecutionStatus = 'Pending' | 'Running' | 'Success' | 'Failed' | 'NeedsHuman'

const STATUS_COLORS: Record<ExecutionStatus, string> = {
  Pending: '#64748b',
  Running: '#3b82f6',
  Success: '#22c55e',
  Failed: '#ef4444',
  NeedsHuman: '#f59e0b',
}

interface BaseNodeData {
  label: string
  blockId: string
  nodeType: BlockType
  config: Record<string, unknown>
  timeoutSeconds?: number
  condition?: string
  runtime?: AgentRuntime
  // Only set by the read-only Delivery Live View graph — undefined in Pipeline
  // Creator, where no execution status exists yet. Renders as an overlay ring on
  // the same node shape, not a separate component.
  executionStatus?: ExecutionStatus
  // Hides the connection-point dots (visible but non-interactive DOM elements,
  // kept for edge anchoring) — set by the read-only Delivery Live View, where
  // edges are fixed and dragging new connections isn't possible anyway.
  hideHandles?: boolean
}

interface Props {
  id: string
  data: BaseNodeData
  selected?: boolean
}

export default function BaseNode({ id, data, selected }: Props) {
  const color = TYPE_COLORS[data.nodeType] ?? '#6f5fe8'
  const statusColor = data.executionStatus ? STATUS_COLORS[data.executionStatus] : undefined
  const borderColor = statusColor ?? (selected ? color : `${color}66`)

  return (
    <div
      style={{
        background: '#1a1f2e',
        border: `1.5px solid ${borderColor}`,
        borderRadius: 8,
        minWidth: 160,
        boxShadow: statusColor
          ? `0 0 0 2px ${statusColor}55${data.executionStatus === 'Running' ? ', 0 0 14px 2px ' + statusColor + '66' : ''}`
          : selected ? `0 0 0 2px ${color}44` : undefined,
        animation: data.executionStatus === 'Running' ? 'axon-node-pulse 1.6s infinite' : undefined,
        position: 'relative',
      }}
    >
      {data.executionStatus && data.executionStatus !== 'Pending' && (
        <div
          title={data.executionStatus}
          style={{
            position: 'absolute', top: -8, left: -8,
            width: 16, height: 16, borderRadius: '50%',
            background: statusColor, border: '2px solid #0f1117',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 9, color: '#0f1117', fontWeight: 700, zIndex: 2,
          }}
        >
          {data.executionStatus === 'Success' && '✓'}
          {data.executionStatus === 'Failed' && '✕'}
          {data.executionStatus === 'NeedsHuman' && '⏸'}
          {data.executionStatus === 'Running' && (
            <div style={{
              width: 8, height: 8, borderRadius: '50%',
              border: '2px solid #0f1117', borderTopColor: 'transparent',
              animation: 'axon-node-spin 0.7s linear infinite',
            }} />
          )}
        </div>
      )}
      <Handle type="target" position={Position.Left}  id="left"   style={handleStyle(color, data.hideHandles)} />
      <Handle type="target" position={Position.Top}   id="top"    style={handleStyle(color, data.hideHandles)} />
      <Handle type="source" position={Position.Bottom} id="bottom" style={handleStyle(color, data.hideHandles)} />

      {/* Tooltip with comprehensive info */}
      <div
        title={`${data.nodeType} • ${data.label}${data.runtime ? ` • ${RUNTIME_LABELS[data.runtime]}` : ''}`}
        style={{ cursor: 'pointer' }}
      >
        {/* Runtime badge — top right corner */}
        {data.runtime && (
          <img
            src={getRuntimeIcon(data.runtime)}
            alt={RUNTIME_LABELS[data.runtime]}
            title={RUNTIME_LABELS[data.runtime]}
            style={{
              position: 'absolute',
              top: -8,
              right: 4,
              width: 18,
              height: 18,
              borderRadius: 2,
              border: '2px solid #1a1f2e',
              background: '#1a1f2e',
            }}
          />
        )}

        {/* Main content */}
        <div style={{ padding: '8px 14px', display: 'flex', alignItems: 'stretch', gap: 10 }}>
          {/* Role icon — spans full height */}
          <img
            src={getBlockTypeIcon(data.nodeType)}
            alt={data.nodeType}
            style={{ width: 32, height: 32, borderRadius: 4, flexShrink: 0, alignSelf: 'center' }}
          />

          {/* Block name and role name */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 4 }}>
            <div style={{ color: '#e2e8f0', fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.1 }}>
              {data.label}
            </div>
            <div style={{ fontSize: 9, color: `${color}bb`, fontWeight: 600, lineHeight: 1 }}>
              {data.nodeType}
            </div>
          </div>
        </div>
      </div>

      {data.condition && (
        <div
          style={{
            margin: '0 10px 8px',
            fontSize: 10,
            background: '#6f5fe822',
            border: '1px solid #6f5fe844',
            borderRadius: 4,
            padding: '2px 6px',
            color: '#a78bfa',
          }}
        >
          {data.condition}
        </div>
      )}

      <Handle type="source" position={Position.Right} id="right" style={handleStyle(color, data.hideHandles)} />
    </div>
  )
}
