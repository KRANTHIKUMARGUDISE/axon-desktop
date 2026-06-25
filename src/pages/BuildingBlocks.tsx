import { useState, useMemo, useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { BlockType, BuildingBlock } from '../types'
import { useBlocks } from '../hooks/useBlocks'
import { getBlockTypeIcon } from '../utils/blockTypeIcons'
import BlockCard from '../components/blocks/BlockCard'
import BlockDetailPanel from '../components/blocks/BlockDetailPanel'
import CreateBlockForm from '../components/blocks/CreateBlockForm'

const ALL_TYPES: BlockType[] = ['Decision', 'Execution', 'Knowledge', 'Control', 'Utility', 'IO']

const SHAPE_DESCRIPTIONS: Record<BlockType, string> = {
  Decision:  'Routes flow on output',
  Execution: 'Does actual work',
  Knowledge: 'Fetches and injects context',
  Control:   'Gates, loops, waits',
  Utility:   'Notifications, webhooks',
  IO:        'Pipeline entry and exit',
}

export default function BuildingBlocks() {
  // Set window title
  useEffect(() => {
    if (window.axon?.window?.setTitle) {
      window.axon.window.setTitle('AXON — Building Blocks')
    }
  }, [])

  const [selectedType, setSelectedType] = useState<BlockType | 'All'>('All')
  const [search, setSearch] = useState('')
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [editingBlock, setEditingBlock] = useState<BuildingBlock | null>(null)
  const [showShapeLegend, setShowShapeLegend] = useState(false)
  const queryClient = useQueryClient()

  const { blocks, loading: isLoading, error } = useBlocks()

  const filtered = useMemo(() => {
    let b = blocks
    if (selectedType !== 'All') b = b.filter(x => (x.role || x.type) === selectedType)
    if (search.trim()) {
      const q = search.toLowerCase()
      b = b.filter(x => x.name.toLowerCase().includes(q) || x.description.toLowerCase().includes(q))
    }
    return b
  }, [blocks, selectedType, search])

  const counts = useMemo(() => {
    const c: Record<string, number> = { All: blocks.length }
    ALL_TYPES.forEach(t => { c[t] = blocks.filter(b => (b.role || b.type) === t).length })
    return c
  }, [blocks])

  const handleCreated = (block: BuildingBlock) => {
    queryClient.invalidateQueries({ queryKey: ['blocks'] })
    if (editingBlock) queryClient.invalidateQueries({ queryKey: ['block', block.id] })
    setShowCreateForm(false)
    setEditingBlock(null)
    setSelectedBlockId(block.id)
  }

  const handleEdit = (block: BuildingBlock) => {
    setEditingBlock(block)
    setShowCreateForm(true)
    setSelectedBlockId(null)
  }

  const showRightPanel = selectedBlockId !== null || showCreateForm

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Top bar */}
      <div style={{ padding: '20px 24px 0', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--axon-t1)' }}>Building Blocks</h1>
            <p style={{ margin: '4px 0 0', fontSize: 13.5, color: 'var(--axon-t3)' }}>
              Reusable agents, actions and controls for your pipelines
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => toast.info('Import coming soon')}
              style={{
                padding: '8px 14px', borderRadius: 7, border: '1px solid var(--axon-border2)',
                background: 'var(--axon-bg4)', color: 'var(--axon-t2)', fontSize: 13, cursor: 'pointer',
              }}
            >
              ↑ Import
            </button>
            <button
              onClick={() => { setEditingBlock(null); setShowCreateForm(true); setSelectedBlockId(null) }}
              style={{
                padding: '8px 14px', borderRadius: 7, border: 'none',
                background: 'var(--axon-nexus)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
              }}
            >
              + Create Block
            </button>
          </div>
        </div>

        {/* Shape legend — collapsible */}
        <div style={{
          background: 'var(--axon-bg3)', border: '1px solid var(--axon-border)',
          borderRadius: 10, marginBottom: 18,
        }}>
          <button
            onClick={() => setShowShapeLegend(!showShapeLegend)}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 8,
              padding: '14px 18px', border: 'none', background: 'transparent',
              cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--axon-t3)', textTransform: 'uppercase', letterSpacing: '0.06em', flex: 1, textAlign: 'left' }}>
              Block Types Legend
            </span>
            <span style={{ fontSize: 12, color: 'var(--axon-t3)' }}>
              {showShapeLegend ? '▼' : '▶'}
            </span>
          </button>

          {showShapeLegend && (
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', padding: '0 18px 16px', borderTop: '1px solid var(--axon-border)' }}>
              {ALL_TYPES.map(t => (
                <div key={t} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, minWidth: 80 }}>
                  <img
                    src={getBlockTypeIcon(t)}
                    alt={t}
                    style={{ width: 40, height: 40, borderRadius: 6 }}
                  />
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--axon-t1)', textAlign: 'center' }}>{t}</div>
                  <div style={{ fontSize: 10, color: 'var(--axon-t3)', textAlign: 'center', lineHeight: 1.3 }}>{SHAPE_DESCRIPTIONS[t]}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Type tabs + search */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {(['All', ...ALL_TYPES] as const).map(t => (
              <button
                key={t}
                onClick={() => setSelectedType(t)}
                style={{
                  padding: '6px 12px', borderRadius: 6, fontSize: 12.5, cursor: 'pointer',
                  border: selectedType === t ? '1px solid var(--axon-nexus)' : '1px solid var(--axon-border)',
                  background: selectedType === t ? 'rgba(111,95,232,0.15)' : 'var(--axon-bg4)',
                  color: selectedType === t ? 'var(--axon-nexus2)' : 'var(--axon-t3)',
                  fontWeight: selectedType === t ? 600 : 400,
                }}
              >
                {t} <span style={{ opacity: 0.7 }}>{counts[t] ?? 0}</span>
              </button>
            ))}
          </div>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search blocks…"
            style={{
              marginLeft: 'auto', padding: '7px 12px', borderRadius: 7, fontSize: 13,
              background: 'var(--axon-bg4)', border: '1px solid var(--axon-border2)',
              color: 'var(--axon-t1)', outline: 'none', width: 200,
            }}
          />
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, display: 'flex', gap: 16, padding: '0 24px 24px', overflow: 'hidden', minHeight: 0 }}>
        {/* Block grid */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {isLoading ? (
            <div style={{ display: 'grid', gridTemplateColumns: showRightPanel ? 'repeat(2, 1fr)' : 'repeat(3, 1fr)', gap: 12 }}>
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} style={{ padding: '14px 16px', borderRadius: 10, background: 'var(--axon-bg3)', border: '1px solid var(--axon-border)', display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', position: 'relative' }}>
                    <div style={{ width: 38, height: 38, borderRadius: 4, background: 'var(--axon-bg5)' }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ height: 14, background: 'var(--axon-bg5)', borderRadius: 4, marginBottom: 6, width: '70%' }} />
                      <div style={{ height: 12, background: 'var(--axon-bg5)', borderRadius: 4, width: '40%' }} />
                    </div>
                    <div style={{ position: 'absolute', top: 0, right: 0, width: 60, height: 24, background: 'var(--axon-bg5)', borderRadius: 4 }} />
                  </div>
                  <div style={{ height: 30, background: 'var(--axon-bg5)', borderRadius: 4 }} />
                  <div style={{ height: 8, background: 'var(--axon-bg5)', borderRadius: 4 }} />
                </div>
              ))}
            </div>
          ) : error ? (
            <div style={{ color: 'var(--axon-red)', fontSize: 13, padding: 8 }}>
              Failed to load blocks. Check your backend connection.
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ color: 'var(--axon-t3)', fontSize: 13, padding: 8 }}>No blocks found.</div>
          ) : (
            <div style={{
              display: 'grid',
              gridTemplateColumns: showRightPanel ? 'repeat(2, 1fr)' : 'repeat(3, 1fr)',
              gap: 12,
              alignContent: 'start',
            }}>
              {filtered.map(block => (
                <BlockCard
                  key={block.id}
                  block={block}
                  selected={selectedBlockId === block.id}
                  onClick={() => {
                    setSelectedBlockId(block.id)
                    setShowCreateForm(false)
                    setEditingBlock(null)
                  }}
                />
              ))}
            </div>
          )}
        </div>

        {/* Right panel */}
        {showRightPanel && (
          showCreateForm ? (
            <CreateBlockForm
              existingBlock={editingBlock ?? undefined}
              onClose={() => { setShowCreateForm(false); setEditingBlock(null) }}
              onCreated={handleCreated}
            />
          ) : selectedBlockId ? (
            <BlockDetailPanel
              blockId={selectedBlockId}
              onClose={() => setSelectedBlockId(null)}
              onEdit={handleEdit}
            />
          ) : null
        )}
      </div>
    </div>
  )
}
