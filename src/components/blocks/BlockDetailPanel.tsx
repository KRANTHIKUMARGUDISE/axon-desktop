import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { getBlock } from '../../services/blocksService'
import { getBlockTypeIcon } from '../../utils/blockTypeIcons'
import { getRuntimeIcon, RUNTIME_LABELS } from '../../utils/runtimeIcons'
import type { BlockType } from '../../types'

const TYPE_COLORS: Record<string, string> = {
  Decision: '#f472b6',
  Execution: '#38bdf8',
  Knowledge: '#22d3b8',
  Control: '#f59e0b',
  Utility: '#a78bfa',
  IO: '#34d399',
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

function hoursAgo(iso?: string): string {
  if (!iso) return '?'
  const diff = Date.now() - new Date(iso).getTime()
  const h = Math.floor(diff / 3600000)
  return h < 1 ? '<1' : String(h)
}

function formatCachedAt(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return `Today ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
  }
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
}

interface Props {
  blockId: string
  onClose: () => void
}

export default function BlockDetailPanel({ blockId, onClose }: Props) {
  const navigate = useNavigate()
  const [tab, setTab] = useState<'details' | 'usedin'>('details')

  const { data: block, isLoading, error } = useQuery({
    queryKey: ['block', blockId],
    queryFn: () => getBlock(blockId),
    enabled: !!blockId,
  })

  if (isLoading)
    return (
      <div style={{ padding: 24 }}>
        {[80, 140, 60, 100].map((w, i) => (
          <div
            key={i}
            style={{
              height: 14,
              width: w,
              background: 'var(--axon-bg3)',
              borderRadius: 4,
              marginBottom: 10,
            }}
          />
        ))}
      </div>
    )
  if (error)
    return (
      <div style={{ padding: 24, color: 'var(--axon-red)', fontSize: 13 }}>Failed to load block.</div>
    )
  if (!block) return null

  const blockType = block.role || block.type || 'Execution'
  const color = TYPE_COLORS[blockType]
  const sourceType = block.sourceType || 'Local'
  const runtime = block.agentRuntime || 'Claude'
  const contextRequirements = block.contextRequirements ?? []
  const outputSchema = block.outputSchema ?? []
  const inputs = block.inputs ?? []
  const outputs = block.outputs ?? []
  const tags = block.tags ?? []
  const cachedFiles = block.cachedFiles ?? []
  const isAxonBlock = sourceType === 'Axon'

  const handleDeactivate = () => {
    if (!window.confirm(`Deactivate "${block.name}"? This will remove it from active use.`)) return
    toast.success(`${block.name} deactivated`)
    onClose()
  }

  const handleSync = () => {
    console.log('Sync triggered:', block.id)
    toast.info('Sync triggered (dev mode)')
  }

  const pipelines = block.usedInPipelineIds ?? []

  return (
    <div
      style={{
        width: 420,
        flexShrink: 0,
        background: 'var(--axon-bg3)',
        border: '1px solid var(--axon-border)',
        borderRadius: 10,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div style={{ padding: '16px 16px 12px', borderBottom: '1px solid var(--axon-border)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
          <img
            src={getBlockTypeIcon(blockType as BlockType)}
            alt={blockType}
            style={{ width: 56, height: 56, flexShrink: 0, borderRadius: 6 }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--axon-t1)' }}>{block.name}</div>
            <span
              style={{
                fontSize: 11,
                fontWeight: 500,
                padding: '2px 7px',
                borderRadius: 4,
                background: `${color}22`,
                color,
                display: 'inline-block',
                marginTop: 4,
              }}
            >
              {blockType}
            </span>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--axon-t3)',
              cursor: 'pointer',
              fontSize: 18,
              lineHeight: 1,
              padding: 2,
              flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>
        <p style={{ fontSize: 12.5, color: 'var(--axon-t2)', lineHeight: 1.55, margin: 0 }}>
          {block.description}
        </p>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--axon-border)' }}>
        {(['details', 'usedin'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              flex: 1,
              padding: '10px 0',
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              fontSize: 12.5,
              fontWeight: tab === t ? 600 : 400,
              color: tab === t ? 'var(--axon-nexus2)' : 'var(--axon-t3)',
              borderBottom: tab === t ? '2px solid var(--axon-nexus)' : '2px solid transparent',
            }}
          >
            {t === 'details' ? 'Details' : 'Used In'}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        {tab === 'details' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* Source Type & Runtime */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
                <span style={{ color: 'var(--axon-t3)' }}>Source</span>
                <span style={{ color: 'var(--axon-t1)', fontWeight: 500 }}>{sourceType}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12.5 }}>
                <span style={{ color: 'var(--axon-t3)' }}>Runtime</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <img
                    src={getRuntimeIcon(runtime)}
                    alt={RUNTIME_LABELS[runtime]}
                    style={{ width: 16, height: 16, borderRadius: 2 }}
                  />
                  <span style={{ color: 'var(--axon-t1)', fontWeight: 500 }}>{RUNTIME_LABELS[runtime]}</span>
                </div>
              </div>
            </div>

            <div style={{ height: 1, background: 'var(--axon-border)' }} />

            {/* Artifact Section (for Local blocks) */}
            {sourceType === 'Local' && (
              <>
                <div>
                  <div
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      color: 'var(--axon-t3)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.06em',
                      marginBottom: 8,
                    }}
                  >
                    Artifact
                  </div>
                  {block.artifactName && (
                    <div style={{ fontSize: 12.5, color: 'var(--axon-t1)', fontWeight: 500, marginBottom: 6 }}>
                      {block.artifactName}
                    </div>
                  )}
                  {block.entryPointPath && (
                    <div style={{ fontSize: 11, color: 'var(--axon-t3)', marginBottom: 6 }}>
                      Entry point: <span style={{ fontFamily: 'monospace', color: 'var(--axon-t1)' }}>{block.entryPointPath}</span>
                    </div>
                  )}
                  {cachedFiles.length > 0 && (
                    <div
                      style={{
                        fontSize: 10,
                        background: 'var(--axon-bg4)',
                        border: '1px solid var(--axon-border2)',
                        borderRadius: 4,
                        padding: '6px 8px',
                        color: 'var(--axon-t2)',
                        maxHeight: 120,
                        overflowY: 'auto',
                      }}
                    >
                      {cachedFiles.map((file) => {
                        const filePath = typeof file === 'string' ? file : file.relativePath || file
                        return (
                          <div key={filePath} style={{ fontFamily: 'monospace', marginBottom: 2 }}>
                            {filePath === block.entryPointPath && '✓ '}
                            {filePath}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
                <div style={{ height: 1, background: 'var(--axon-border)' }} />
              </>
            )}

            {/* Key-value */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[
                ['Version', block.version],
                ['Created by', block.createdByName ?? '—'],
                ['Runs', (block.usageCount ?? 0).toLocaleString()],
                ['Success rate', '91%'],
              ].map(([label, value]) => (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
                  <span style={{ color: 'var(--axon-t3)' }}>{label}</span>
                  <span style={{ color: 'var(--axon-t1)', fontWeight: 500 }}>{value}</span>
                </div>
              ))}
              {block.cachedAt && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
                  <span style={{ color: 'var(--axon-t3)' }}>Cached at</span>
                  <span style={{ color: 'var(--axon-t1)', fontWeight: 500 }}>{formatCachedAt(block.cachedAt)}</span>
                </div>
              )}
            </div>

            <div style={{ height: 1, background: 'var(--axon-border)' }} />

            {/* Context Requirements */}
            <div>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  color: 'var(--axon-t3)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  marginBottom: 4,
                }}
              >
                Context Requirements
              </div>
              <div style={{ fontSize: 11, color: 'var(--axon-t3)', marginBottom: 8 }}>
                Delivery context injected before execution
              </div>
              {contextRequirements.length > 0 ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {contextRequirements.map((r) => (
                    <span key={r} style={tealChip}>
                      {r}
                    </span>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 11, color: '#f59e0b' }}>
                  None declared — full context will be injected (higher token cost)
                </div>
              )}
            </div>

            {/* Output Schema */}
            <div>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  color: 'var(--axon-t3)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  marginBottom: 4,
                }}
              >
                Output Schema
              </div>
              <div style={{ fontSize: 11, color: 'var(--axon-t3)', marginBottom: 8 }}>
                Fields returned — enables branch conditions
              </div>
              {outputSchema.length > 0 ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {outputSchema.map((f) => (
                    <span key={f} style={purpleChip}>
                      {f}
                    </span>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 11, color: 'var(--axon-t3)' }}>None declared — branch conditions unavailable</div>
              )}
            </div>

            <div style={{ height: 1, background: 'var(--axon-border)' }} />

            {/* Inputs */}
            <div>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'var(--axon-t2)',
                  marginBottom: 8,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                }}
              >
                Inputs
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {inputs.map((port) => (
                  <div key={port.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: TYPE_COLORS[port.type] ?? '#888',
                        flexShrink: 0,
                        display: 'inline-block',
                      }}
                    />
                    <span style={{ color: 'var(--axon-t1)', fontWeight: 500 }}>{port.name}</span>
                    {port.required && (
                      <span style={{ marginLeft: 'auto', fontSize: 10, color: '#f472b6' }}>required</span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div style={{ height: 1, background: 'var(--axon-border)' }} />

            {/* Outputs */}
            <div>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'var(--axon-t2)',
                  marginBottom: 8,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                }}
              >
                Outputs
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {outputs.map((port) => (
                  <div key={port.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: TYPE_COLORS[port.type] ?? '#888',
                        flexShrink: 0,
                        display: 'inline-block',
                      }}
                    />
                    <span style={{ color: 'var(--axon-t1)', fontWeight: 500 }}>{port.name}</span>
                    {port.required && (
                      <span style={{ marginLeft: 'auto', fontSize: 10, color: '#f472b6' }}>required</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div>
            {pipelines.length === 0 ? (
              <p style={{ fontSize: 12.5, color: 'var(--axon-t3)', margin: 0 }}>Not used in any pipeline yet</p>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {pipelines.map((name) => (
                  <span
                    key={name}
                    style={{
                      fontSize: 12,
                      padding: '4px 10px',
                      borderRadius: 6,
                      background: 'var(--axon-bg5)',
                      color: 'var(--axon-t2)',
                      border: '1px solid var(--axon-border)',
                    }}
                  >
                    {name}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div
        style={{
          padding: '12px 16px',
          borderTop: '1px solid var(--axon-border)',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <button
          onClick={() => navigate('/pipelines/new')}
          style={{
            width: '100%',
            padding: '8px 0',
            borderRadius: 7,
            border: 'none',
            background: 'var(--axon-nexus)',
            color: '#fff',
            fontWeight: 600,
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          Add to pipeline
        </button>
        {!isAxonBlock && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={handleSync}
              style={{
                flex: 1,
                padding: '7px 0',
                borderRadius: 7,
                background: 'rgba(34,211,184,0.1)',
                border: '1px solid rgba(34,211,184,0.25)',
                color: 'var(--axon-teal)',
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              ↺ Sync
            </button>
            <button
              onClick={() => toast.info('Edit coming soon')}
              style={{
                flex: 1,
                padding: '7px 0',
                borderRadius: 7,
                background: 'var(--axon-bg5)',
                border: '1px solid var(--axon-border)',
                color: 'var(--axon-t1)',
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              Edit
            </button>
            <button
              onClick={handleDeactivate}
              style={{
                flex: 1,
                padding: '7px 0',
                borderRadius: 7,
                background: 'rgba(239,68,68,0.1)',
                border: '1px solid rgba(239,68,68,0.25)',
                color: '#ef4444',
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              Deactivate
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
