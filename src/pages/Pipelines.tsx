import { useState, useMemo, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient, useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { deletePipeline, createPipeline } from '../services/pipelinesService'
import { usePipelines } from '../hooks/usePipelines'
import { useBlocks } from '../hooks/useBlocks'
import { useAuthReady } from '../hooks/useAuthReady'
import type { Pipeline, CreatePipelineRequest } from '../types'
import PipelineCard from '../components/pipeline/PipelineCard'
import NewDeliveryModal from '../components/delivery/NewDeliveryModal'

type VisibilityFilter = 'all' | 'mine' | 'team' | 'organisation'

export default function Pipelines() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  // Set window title
  useEffect(() => {
    if (window.axon?.window?.setTitle) {
      window.axon.window.setTitle('AXON — Pipelines')
    }
  }, [])

  const [search, setSearch] = useState('')
  const [visibilityFilter, setVisibilityFilter] = useState<VisibilityFilter>('all')
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [runTarget, setRunTarget] = useState<Pipeline | null>(null)
  const [currentUserId, setCurrentUserId] = useState<string>('')
  const [currentUserName, setCurrentUserName] = useState<string>('')
  const [currentTeam, setCurrentTeam] = useState<string>('')

  const authReady = useAuthReady()
  const { data: pipelines, isLoading, isError } = usePipelines(undefined, authReady)
  const { blocks } = useBlocks()

  useEffect(() => {
    async function loadUserInfo() {
      const [userId, userName, team] = await Promise.all([
        window.axon.settings.get('userId') as Promise<string | null>,
        window.axon.settings.get('userName') as Promise<string | null>,
        window.axon.settings.get('team') as Promise<string | null>,
      ])
      setCurrentUserId(userId || '')
      setCurrentUserName(userName || '')
      setCurrentTeam(team || '')
    }
    loadUserInfo()
  }, [])

  // Create a map of blockId -> block type for MiniFlowPreview. `role` is the current
  // field; `type` is legacy and almost always undefined on real blocks now — falling
  // back to it (rather than the other way around) is why every card's icons collapsed
  // to the 'Execution' default regardless of each block's actual role.
  const blockTypeMap = useMemo(() => {
    const map = new Map<string, string>()
    blocks.forEach(block => {
      map.set(block.id, block.role ?? block.type)
    })
    return map
  }, [blocks])

  const deleteM = useMutation({
    mutationFn: (id: string) => deletePipeline(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['pipelines'] }),
  })

  const duplicateM = useMutation({
    mutationFn: async (pipeline: Pipeline) => {
      const req: CreatePipelineRequest = {
        name: `${pipeline.name} (copy)`,
        description: pipeline.description,
        nodes: pipeline.nodes ?? [],
        edges: pipeline.edges ?? [],
      }
      return createPipeline(req)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pipelines'] })
      toast.success('Pipeline duplicated')
    },
    onError: () => toast.error('Failed to duplicate pipeline'),
  })

  const allTags = Array.from(new Set((pipelines ?? []).flatMap((p) => p.tags ?? [])))

  const filtered = (pipelines ?? []).filter((p) => {
    const matchesSearch =
      !search ||
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      (p.description ?? '').toLowerCase().includes(search.toLowerCase())
    const matchesTags = selectedTags.length === 0 || selectedTags.some((t) => (p.tags ?? []).includes(t))

    let matchesVisibility = true
    if (visibilityFilter === 'mine') {
      matchesVisibility = p.createdBy === currentUserId
    } else if (visibilityFilter === 'team') {
      matchesVisibility = p.ownerTeam === currentTeam && !!currentTeam
    }
    // organisation filter is for future use, always shows all

    return matchesSearch && matchesTags && matchesVisibility
  })

  const activeCount = (pipelines ?? []).filter((p) => p.isActive).length

  function toggleTag(tag: string) {
    setSelectedTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]))
  }

  function handleRun(pipeline: Pipeline) {
    setRunTarget(pipeline)
  }

  function handleEdit(pipeline: Pipeline) {
    navigate(`/pipelines/${pipeline.id}/edit`)
  }

  function handleDuplicate(pipeline: Pipeline) {
    duplicateM.mutate(pipeline)
  }

  function handleDelete(pipeline: Pipeline) {
    deleteM.mutate(pipeline.id, {
      onSuccess: () => toast.success(`Deleted "${pipeline.name}"`),
      onError: () => toast.error(`Failed to delete "${pipeline.name}"`),
    })
  }

  function handlePromote(pipeline: Pipeline) {
    toast.info(`Organisational promotion request for "${pipeline.name}" submitted. Coming soon!`)
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--axon-bg)', display: 'flex', flexDirection: 'column' }}>
      {/* Top bar */}
      <div style={{
        padding: '20px 24px 0',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        flexShrink: 0,
      }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--axon-t1)', margin: 0 }}>Pipelines</h1>
          <p style={{ fontSize: 13, color: 'var(--axon-t3)', margin: '4px 0 0' }}>
            Browse, run and manage your delivery pipelines
          </p>
        </div>
        <button
          onClick={() => navigate('/pipelines/new')}
          style={{
            background: 'var(--axon-nexus, #6f5fe8)', border: 'none', color: '#fff',
            borderRadius: 7, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}
        >
          + New Pipeline
        </button>
      </div>

      {/* Stats row */}
      <div style={{ padding: '16px 24px 0', display: 'flex', gap: 12, flexShrink: 0 }}>
        {[
          { label: 'Total Pipelines', value: (pipelines ?? []).length },
          { label: 'Active', value: activeCount },
        ].map((stat) => (
          <div key={stat.label} style={{
            background: 'var(--axon-bg2)', border: '1px solid var(--axon-border)',
            borderRadius: 8, padding: '10px 16px', minWidth: 120,
          }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--axon-t1)' }}>{stat.value}</div>
            <div style={{ fontSize: 11, color: 'var(--axon-t3)', marginTop: 2 }}>{stat.label}</div>
          </div>
        ))}
      </div>

      {/* Filter row */}
      <div style={{ padding: '12px 24px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', flexShrink: 0 }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search pipelines..."
          style={{
            background: 'var(--axon-bg2)', border: '1px solid var(--axon-border)',
            borderRadius: 6, padding: '6px 12px', fontSize: 12, color: 'var(--axon-t1)',
            outline: 'none', width: 220,
          }}
        />

        {/* Visibility filter */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {(['all', 'mine', 'team', 'organisation'] as const).map((visibility) => (
            <button
              key={visibility}
              onClick={() => setVisibilityFilter(visibility)}
              disabled={visibility === 'team' && !currentTeam || visibility === 'organisation'}
              style={{
                fontSize: 11, padding: '4px 10px', borderRadius: 5, cursor: (visibility === 'team' && !currentTeam) || visibility === 'organisation' ? 'not-allowed' : 'pointer',
                fontWeight: visibilityFilter === visibility ? 600 : 400,
                background: visibilityFilter === visibility ? 'rgba(111,95,232,0.15)' : 'var(--axon-bg2)',
                color: (visibility === 'team' && !currentTeam) || visibility === 'organisation' ? 'var(--axon-t4)' : visibilityFilter === visibility ? '#a78bfa' : 'var(--axon-t3)',
                border: visibilityFilter === visibility ? '1px solid rgba(111,95,232,0.35)' : '1px solid var(--axon-border)',
                transition: 'all 0.12s',
                opacity: (visibility === 'team' && !currentTeam) || visibility === 'organisation' ? 0.5 : 1,
              }}
              title={
                visibility === 'team' && !currentTeam ? 'Team filter available after setting team in Settings' :
                visibility === 'organisation' ? 'Coming soon' :
                ''
              }
            >
              {visibility === 'organisation' ? 'Org' : visibility.charAt(0).toUpperCase() + visibility.slice(1)}
            </button>
          ))}
        </div>

        {/* Tags filter */}
        {allTags.length > 0 && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: 'var(--axon-t3)' }}>Tags:</span>
            {allTags.map((tag) => (
              <button
                key={tag}
                onClick={() => toggleTag(tag)}
                style={{
                  fontSize: 11, padding: '4px 10px', borderRadius: 5, cursor: 'pointer',
                  fontWeight: selectedTags.includes(tag) ? 600 : 400,
                  background: selectedTags.includes(tag) ? 'rgba(111,95,232,0.15)' : 'var(--axon-bg2)',
                  color: selectedTags.includes(tag) ? '#a78bfa' : 'var(--axon-t3)',
                  border: selectedTags.includes(tag) ? '1px solid rgba(111,95,232,0.35)' : '1px solid var(--axon-border)',
                  transition: 'all 0.12s',
                }}
              >
                {tag}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Content */}
      <div style={{ flex: 1, padding: '0 24px 24px' }}>
        {isLoading ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
            {[1, 2, 3, 4].map((n) => (
              <div key={n} style={{ height: 160, background: 'var(--axon-bg2)', border: '1px solid var(--axon-border)', borderRadius: 10 }} />
            ))}
          </div>
        ) : isError ? (
          <div style={{ padding: '60px 0', textAlign: 'center' }}>
            <div style={{ fontSize: 14, color: 'var(--axon-red)', marginBottom: 6 }}>Failed to load pipelines</div>
            <button
              onClick={() => queryClient.invalidateQueries({ queryKey: ['pipelines'] })}
              style={{ fontSize: 12, color: '#a78bfa', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
            >
              Retry
            </button>
          </div>
        ) : (pipelines ?? []).length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: '80px 0' }}>
            <svg width="48" height="48" viewBox="0 0 48 48" fill="none" style={{ opacity: 0.2 }}>
              <rect x="4" y="18" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="2" />
              <rect x="36" y="18" width="8" height="12" rx="2" stroke="currentColor" strokeWidth="2" />
              <line x1="16" y1="24" x2="36" y2="24" stroke="currentColor" strokeWidth="2" />
              <circle cx="24" cy="24" r="3" fill="currentColor" />
            </svg>
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--axon-t2)' }}>No pipelines yet</div>
            <div style={{ fontSize: 13, color: 'var(--axon-t3)' }}>Create your first pipeline to start delivering autonomously</div>
            <button
              onClick={() => navigate('/pipelines/new')}
              style={{
                background: 'var(--axon-nexus, #6f5fe8)', border: 'none', color: '#fff',
                borderRadius: 7, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', marginTop: 4,
              }}
            >
              + Create Pipeline
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '60px 0' }}>
            <div style={{ fontSize: 15, color: 'var(--axon-t2)' }}>No pipelines match your search</div>
            <button
              onClick={() => { setSearch(''); setVisibilityFilter('all'); setSelectedTags([]) }}
              style={{ fontSize: 12, color: '#a78bfa', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
            >
              Clear filters
            </button>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
            {filtered.map((pipeline) => (
              <PipelineCard
                key={pipeline.id}
                pipeline={pipeline}
                blockTypeMap={blockTypeMap}
                onRun={handleRun}
                onEdit={handleEdit}
                onDuplicate={handleDuplicate}
                onDelete={handleDelete}
                onPromote={handlePromote}
              />
            ))}
          </div>
        )}
      </div>

      <NewDeliveryModal
        isOpen={!!runTarget}
        onClose={() => setRunTarget(null)}
        defaultPipelineId={runTarget?.id}
      />
    </div>
  )
}
