import type { BuildingBlock } from '../../types'
import { getBlockTypeIcon } from '../../utils/blockTypeIcons'
import { getRuntimeIcon, RUNTIME_LABELS } from '../../utils/runtimeIcons'

const TYPE_COLORS: Record<string, string> = {
  Decision: 'rgba(244,114,182,0.15)',
  Execution: 'rgba(56,189,248,0.15)',
  Knowledge: 'rgba(34,211,184,0.15)',
  Control: 'rgba(245,158,11,0.15)',
  Utility: 'rgba(167,139,250,0.15)',
  IO: 'rgba(52,211,153,0.15)',
}
const TYPE_TEXT: Record<string, string> = {
  Decision: '#f472b6',
  Execution: '#38bdf8',
  Knowledge: '#22d3b8',
  Control: '#f59e0b',
  Utility: '#a78bfa',
  IO: '#34d399',
}

const SOURCE_LABEL: Record<string, string> = {
  Axon: 'Axon',
  Local: 'Local',
  Marketplace: 'Marketplace',
  CDF: 'CDF',
}

const chipBase: React.CSSProperties = {
  borderRadius: 20,
  padding: '1px 7px',
  fontSize: 9,
  fontWeight: 500,
  display: 'inline-block',
  whiteSpace: 'nowrap',
}

const tealChip: React.CSSProperties = {
  ...chipBase,
  background: 'var(--axon-teal-d)',
  color: 'var(--axon-teal)',
  border: '1px solid rgba(34,211,184,0.2)',
}

const purpleChip: React.CSSProperties = {
  ...chipBase,
  background: 'var(--axon-nx-glow)',
  color: 'var(--axon-nexus2)',
  border: '1px solid rgba(111,95,232,0.2)',
}

const greyChip: React.CSSProperties = {
  ...chipBase,
  background: 'var(--axon-bg3)',
  color: 'var(--axon-t4)',
  border: '1px solid var(--axon-border)',
}

interface Props {
  block: BuildingBlock
  selected: boolean
  onClick: () => void
}

export default function BlockCard({ block, selected, onClick }: Props) {
  const blockType = block.role || 'Execution'
  const sourceType = block.sourceType || 'Local'
  const runtime = block.agentRuntime || 'Claude'
  const contextRequirements = block.contextRequirements ?? []
  const outputSchema = block.outputSchema ?? []
  const tags = block.tags ?? []
  const usageCount = block.usageCount ?? 0
  const extraReqs = contextRequirements.length > 3 ? contextRequirements.length - 3 : 0
  const extraOut = outputSchema.length > 2 ? outputSchema.length - 2 : 0

  return (
    <div
      onClick={onClick}
      style={{
        background: selected ? 'rgba(111,95,232,0.07)' : 'var(--axon-bg3)',
        border: selected ? '1.5px solid var(--axon-nexus)' : '1px solid var(--axon-border)',
        borderRadius: 10,
        padding: '14px 16px',
        cursor: 'pointer',
        transition: 'border-color 0.15s, background 0.15s',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        position: 'relative',
      }}
    >
      {/* Source indicator + Runtime — top right */}
      <div
        style={{
          position: 'absolute',
          top: 10,
          right: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        {/* Runtime icon */}
        <img
          src={getRuntimeIcon(runtime)}
          alt={RUNTIME_LABELS[runtime]}
          title={RUNTIME_LABELS[runtime]}
          style={{
            width: 20,
            height: 20,
            borderRadius: 3,
            flexShrink: 0,
          }}
        />

        {/* Source indicator */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              flexShrink: 0,
              background: sourceType === 'Axon' ? '#fbbf24' : '#64748b',
              display: 'inline-block',
            }}
          />
          <span style={{ fontSize: 9, color: 'var(--axon-t4)' }}>
            {SOURCE_LABEL[sourceType]}
          </span>
        </div>
      </div>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingRight: 100 }}>
        <img
          src={getBlockTypeIcon(blockType)}
          alt={blockType}
          style={{ width: 38, height: 38, flexShrink: 0, borderRadius: 4 }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontWeight: 600,
              fontSize: 14,
              color: 'var(--axon-t1)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {block.name}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 3 }}>
            <span
              style={{
                fontSize: 11,
                fontWeight: 500,
                padding: '2px 7px',
                borderRadius: 4,
                background: TYPE_COLORS[blockType],
                color: TYPE_TEXT[blockType],
                display: 'inline-block',
              }}
            >
              {blockType}
            </span>
          </div>
        </div>
      </div>

      {/* Description */}
      <div
        style={{
          fontSize: 12.5,
          color: 'var(--axon-t2)',
          lineHeight: 1.55,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {block.description}
      </div>

      {/* Context Requirements */}
      {contextRequirements.length > 0 && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 9, color: 'var(--axon-t4)', flexShrink: 0 }}>Needs:</span>
          {contextRequirements.slice(0, 3).map((r) => (
            <span key={r} style={tealChip}>
              {r}
            </span>
          ))}
          {extraReqs > 0 && <span style={greyChip}>+{extraReqs} more</span>}
        </div>
      )}

      {/* Output Schema */}
      {outputSchema.length > 0 && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 9, color: 'var(--axon-t4)', flexShrink: 0 }}>Returns:</span>
          {outputSchema.slice(0, 2).map((f) => (
            <span key={f} style={purpleChip}>
              {f}
            </span>
          ))}
          {extraOut > 0 && <span style={greyChip}>+{extraOut} more</span>}
        </div>
      )}

      {/* Tags */}
      {tags.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {tags.map((t) => (
            <span
              key={t}
              style={{
                fontSize: 11,
                padding: '2px 7px',
                borderRadius: 4,
                background: 'var(--axon-bg5)',
                color: 'var(--axon-t3)',
                border: '1px solid var(--axon-border)',
              }}
            >
              {t}
            </span>
          ))}
        </div>
      )}

      {/* Footer */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 11,
          color: 'var(--axon-t3)',
          borderTop: '1px solid var(--axon-border)',
          paddingTop: 8,
        }}
      >
        <span style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--axon-t4)' }}>v{block.version}</span>
        <span>{(usageCount ?? 0).toLocaleString()} runs</span>

        {/* Creator Avatar + Name */}
        {block.createdByName && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              marginLeft: 'auto',
            }}
            title={`Created by ${block.createdByName}`}
          >
            <div
              style={{
                width: 20,
                height: 20,
                borderRadius: '50%',
                background: 'var(--axon-nexus)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 8,
                fontWeight: 700,
                color: '#fff',
                flexShrink: 0,
              }}
            >
              {block.createdByName
                .split(' ')
                .map((n) => n[0])
                .join('')
                .toUpperCase()
                .slice(0, 2)}
            </div>
            <span
              style={{
                fontSize: 10,
                color: 'var(--axon-t3)',
                maxWidth: 80,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {block.createdByName}
            </span>
          </div>
        )}

        {block.verified && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 500,
              color: '#22d3b8',
              background: 'rgba(34,211,184,0.1)',
              padding: '2px 6px',
              borderRadius: 3,
              flexShrink: 0,
            }}
          >
            ✓
          </span>
        )}
      </div>
    </div>
  )
}
