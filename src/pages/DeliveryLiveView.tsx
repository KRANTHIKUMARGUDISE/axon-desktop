import '@xyflow/react/dist/style.css'
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap,
  type Node, type Edge, type NodeTypes, type EdgeTypes,
} from '@xyflow/react'
import { useDelivery, useApproveGate, useRejectGate, useCreateDelivery } from '../hooks/useDeliveries'
import { useSignalR } from '../hooks/useSignalR'
import { getBlocks } from '../services/blocksService'
import type { DeliveryStep, ExecutionProgress, BuildingBlock } from '../types'
import type {
  StepStartedEvent, StepCompletedEvent, StepFailedEvent,
  GateReachedEvent, DeliveryCompletedEvent, DeliveryFailedEvent,
} from '../hooks/useSignalR'
import RraBanner from '../components/delivery/RraBanner'
import DecisionNode from '../components/pipeline/nodes/DecisionNode'
import ExecutionNode from '../components/pipeline/nodes/ExecutionNode'
import KnowledgeNode from '../components/pipeline/nodes/KnowledgeNode'
import ControlNode from '../components/pipeline/nodes/ControlNode'
import IONode from '../components/pipeline/nodes/IONode'
import UtilityNode from '../components/pipeline/nodes/UtilityNode'
import ConditionalEdge from '../components/pipeline/ConditionalEdge'
import { getBlockTypeIcon } from '../utils/blockTypeIcons'
import { getRuntimeIcon, RUNTIME_LABELS } from '../utils/runtimeIcons'
import type { ExecutionStatus } from '../components/pipeline/nodes/BaseNode'
import { toast } from 'sonner'

const nodeTypes: NodeTypes = {
  decisionNode: DecisionNode,
  executionNode: ExecutionNode,
  knowledgeNode: KnowledgeNode,
  controlNode: ControlNode,
  ionode: IONode,
  utilityNode: UtilityNode,
}

const edgeTypes: EdgeTypes = {
  conditionalEdge: ConditionalEdge,
}

function stepStatusToExecutionStatus(status?: DeliveryStep['status']): ExecutionStatus {
  switch (status) {
    case 'Running': return 'Running'
    case 'Completed': return 'Success'
    case 'Failed': return 'Failed'
    case 'AwaitingHuman': return 'NeedsHuman'
    default: return 'Pending'
  }
}

interface TimelineEvent {
  type:
    | 'WorkspaceProvisioning' | 'WorkspaceProvisioned'
    | 'GitPreparing' | 'GitPrepared'
    | 'StepStarted' | 'StepCompleted' | 'StepFailed' | 'GateReached'
    | 'DeliveryCompleted' | 'DeliveryFailed'
  body: string
  timestamp: string
}

const eventTypeColor: Record<TimelineEvent['type'], string> = {
  WorkspaceProvisioning: 'var(--axon-t3)',
  WorkspaceProvisioned: 'var(--axon-t3)',
  GitPreparing: 'var(--axon-t3)',
  GitPrepared: 'var(--axon-t3)',
  StepStarted: 'var(--axon-nexus2)',
  StepCompleted: 'var(--axon-green)',
  StepFailed: 'var(--axon-red)',
  GateReached: 'var(--axon-amber)',
  DeliveryCompleted: 'var(--axon-green)',
  DeliveryFailed: 'var(--axon-red)',
}

function timeAgo(iso: string) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  return `${Math.floor(diff / 3600)}h ago`
}

function statusBadgeStyle(status: string): React.CSSProperties {
  switch (status) {
    case 'Running': return { background: 'var(--axon-nx-glow)', color: 'var(--axon-nexus2)', border: '1px solid rgba(111,95,232,0.2)' }
    case 'Paused': return { background: 'var(--axon-amber-d)', color: 'var(--axon-amber)', border: '1px solid rgba(245,158,11,0.2)' }
    case 'Completed': return { background: 'var(--axon-green-d)', color: 'var(--axon-green)', border: '1px solid rgba(16,185,129,0.2)' }
    case 'Failed': return { background: 'var(--axon-red-d)', color: 'var(--axon-red)', border: '1px solid rgba(239,68,68,0.2)' }
    case 'Pending': return { background: 'rgba(100,116,139,0.12)', color: 'var(--axon-t3)', border: '1px solid rgba(100,116,139,0.2)' }
    default: return { background: 'var(--axon-bg3)', color: 'var(--axon-t2)', border: '1px solid var(--axon-border2)' }
  }
}

function formatTotalDuration(startedAt: string, completedAt?: string): string {
  const start = new Date(startedAt).getTime()
  const end = completedAt ? new Date(completedAt).getTime() : Date.now()
  const seconds = Math.round((end - start) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const secs = seconds % 60
  if (minutes < 60) return `${minutes}m ${secs}s`
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return `${hours}h ${mins}m`
}


export default function DeliveryLiveView() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const queryClient = useQueryClient()

  const { data: delivery, isLoading, refetch } = useDelivery(id ?? '')
  const approveGate = useApproveGate(id ?? '')
  const rejectGate = useRejectGate(id ?? '')
  const createDelivery = useCreateDelivery()

  const [localSteps, setLocalSteps] = useState<DeliveryStep[]>([])
  const [timeline, setTimeline] = useState<TimelineEvent[]>([])
  const [localStatus, setLocalStatus] = useState<string | null>(null)
  const [prUrl, setPrUrl] = useState<string | null>(null)
  const [isStarting, setIsStarting] = useState(false)
  const [isStopping, setIsStopping] = useState(false)
  const [isClearingWorkspace, setIsClearingWorkspace] = useState(false)
  const [blocks, setBlocks] = useState<BuildingBlock[]>([])
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [fullFileContent, setFullFileContent] = useState<{ title: string; content: string } | null>(null)
  const nodeStepMapRef = useRef<Map<string, string>>(new Map())
  const autoStartedRef = useRef(false)
  const lastProgressEventRef = useRef<string | null>(null)
  const seededDeliveryIdRef = useRef<string | null>(null)

  // Reset all per-delivery local state when navigating to a different delivery
  // (e.g. via Retry) without a full component remount.
  useEffect(() => {
    if (seededDeliveryIdRef.current !== null && seededDeliveryIdRef.current !== id) {
      setLocalSteps([])
      setTimeline([])
      nodeStepMapRef.current = new Map()
      lastProgressEventRef.current = null
      autoStartedRef.current = false
    }
    seededDeliveryIdRef.current = id ?? null
  }, [id])

  // Sync localSteps from initial fetch + auto-start.
  // Once the backend has persisted steps (run finished), that's the source of truth.
  // Until then, seed Pending placeholders from the pipeline snapshot once, so the
  // live step_started/completed/failed handlers below have something to flip —
  // but don't re-seed on every periodic refetch, or we'd wipe out live progress.
  useEffect(() => {
    if (!delivery) return
    setLocalStatus(null)
    if (delivery.prUrl) {
      setPrUrl(delivery.prUrl)
    }
    if (delivery.steps.length > 0) {
      setLocalSteps(delivery.steps)
      // Live Signals are otherwise purely in-memory (never persisted) — if we're
      // loading a delivery that already has persisted step data and haven't seen
      // any live IPC events this session (fresh mount / reopened later), reconstruct
      // a reasonable signal history from what's already in the DB instead of showing
      // "Waiting for live events…" for a delivery that's actually done.
      setTimeline((prev) => {
        if (prev.length > 0) return prev
        const synthesized: TimelineEvent[] = []
        for (const step of delivery.steps) {
          if (step.startedAt) {
            synthesized.push({ type: 'StepStarted', body: `${step.nodeName ?? step.name} started`, timestamp: step.startedAt })
          }
          if (step.completedAt || step.status === 'Completed' || step.status === 'Failed') {
            const ts = step.completedAt ?? step.startedAt ?? delivery.startedAt
            synthesized.push(
              step.status === 'Failed'
                ? { type: 'StepFailed', body: `${step.nodeName ?? step.name} failed — ${step.errorMessage ?? ''}`, timestamp: ts }
                : { type: 'StepCompleted', body: `${step.nodeName ?? step.name} completed`, timestamp: ts }
            )
          }
        }
        if (delivery.status === 'Completed' && delivery.completedAt) {
          synthesized.push({ type: 'DeliveryCompleted', body: 'Delivery completed', timestamp: delivery.completedAt })
        } else if (delivery.status === 'Failed' && delivery.completedAt) {
          synthesized.push({ type: 'DeliveryFailed', body: 'Delivery failed', timestamp: delivery.completedAt })
        }
        // Newest first, matching how addTimelineEvent() prepends live events
        return synthesized.reverse().slice(0, 10)
      })
    } else {
      setLocalSteps((prev) =>
        prev.length > 0
          ? prev
          : (delivery.pipelineSnapshot?.nodes ?? []).map((n) => ({
              id: n.id,
              name: n.label,
              nodeName: n.label,
              status: 'Pending' as DeliveryStep['status'],
            }))
      )
    }
  }, [delivery, id])

  // Update window title when delivery loads
  useEffect(() => {
    if (window.axon?.window?.setTitle) {
      if (delivery?.title) {
        window.axon.window.setTitle(`AXON — ${delivery.title}`)
      }
    }
  }, [delivery])

  // Fetch block definitions once — needed to resolve each pipeline node's Role
  // (shape/color) and Runtime (badge), same as Pipeline Creator does.
  useEffect(() => {
    getBlocks().then(setBlocks).catch(() => { /* graph still renders without role/runtime info */ })
  }, [])

  const blockMap = useMemo(() => new Map(blocks.map((b) => [b.id, b])), [blocks])

  const flowNodes: Node[] = useMemo(() => {
    const nodes = delivery?.pipelineSnapshot?.nodes ?? []
    return nodes.map((n) => {
      const block = blockMap.get(n.blockId)
      const nodeType = block?.role ?? 'Execution'
      const typeKey = nodeType.toLowerCase()
      const step = localSteps.find((s) => s.id === n.id)
      return {
        id: n.id,
        type: typeKey === 'io' ? 'ionode' : `${typeKey}Node`,
        position: n.position,
        draggable: false,
        connectable: false,
        data: {
          label: n.label,
          blockId: n.blockId,
          nodeType,
          runtime: block?.agentRuntime,
          config: {},
          executionStatus: stepStatusToExecutionStatus(step?.status),
          hideHandles: true,
        },
      }
    })
  }, [delivery, blockMap, localSteps])

  const flowEdges: Edge[] = useMemo(() => {
    const edges = delivery?.pipelineSnapshot?.edges ?? []
    return edges.map((e) => ({
      id: e.id,
      source: e.sourceNodeId,
      target: e.targetNodeId,
      type: 'conditionalEdge',
      data: {
        isDefault: e.isDefault ?? false,
        condition: e.condition?.expression ?? null,
      },
    }))
  }, [delivery])

  const selectedStep = localSteps.find((s) => s.id === selectedNodeId)
  const selectedNode = flowNodes.find((n) => n.id === selectedNodeId)
  const selectedBlock = selectedNode ? blockMap.get((selectedNode.data as { blockId: string }).blockId) : undefined
  const isSelectedNodeActiveGate = selectedNodeId === delivery?.currentNodeId && delivery?.status === 'Paused'

  const onNodeClick = useCallback((_e: React.MouseEvent, node: Node) => {
    setSelectedNodeId(node.id)
  }, [])

  const onPaneClick = useCallback(() => setSelectedNodeId(null), [])

  const viewFullFile = useCallback(async (relativeRef: string, title: string) => {
    if (!delivery?.workspacePath) return
    try {
      const fullPath = await window.axon.workspace.exists(delivery.workspacePath)
        ? `${delivery.workspacePath}/${relativeRef}`.replace(/\\/g, '/')
        : relativeRef
      const content = await window.axon.workspace.readFile(fullPath)
      setFullFileContent({ title, content })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast.error(`Could not read file — is the developer's machine/workspace available? (${message})`)
    }
  }, [delivery])

  // Auto-start delivery when first loaded if in Pending status.
  // The cached `delivery` from useDelivery() can be stale (staleTime: 0 still serves
  // cached data while refetching) — confirm the *current* status via an explicit
  // refetch before deciding to start, instead of acting on a possibly-outdated snapshot.
  useEffect(() => {
    if (!id || autoStartedRef.current) return
    let cancelled = false
    refetch().then((res) => {
      if (cancelled || autoStartedRef.current) return
      if (res.data?.status !== 'Pending') return
      autoStartedRef.current = true
      setLocalStatus('Running')
      window.axon.executor.start(id).then((startRes) => {
        if (!startRes.success) {
          console.error('Auto-start failed:', startRes.error)
          setLocalStatus(null)
          toast.error(startRes.error ? `Failed to start delivery: ${startRes.error}` : 'Failed to start delivery')
        }
      }).catch((err) => {
        console.error('Auto-start error:', err)
        setLocalStatus(null)
        const message = err instanceof Error ? err.message : String(err)
        toast.error(`Failed to start delivery: ${message}`)
      })
    })
    return () => { cancelled = true }
  }, [id, refetch])

  // Periodic sync: refetch every 5s while Running or Paused
  useEffect(() => {
    if (!id || !delivery || !delivery.status) return
    if (delivery.status !== 'Running' && delivery.status !== 'Paused') return

    const interval = setInterval(() => {
      refetch()
    }, 5000)

    return () => clearInterval(interval)
  }, [id, delivery, delivery?.status, refetch])

  // Subscribe to local executor progress events
  useEffect(() => {
    const handler = (_event: unknown, data: ExecutionProgress) => {
      if (data.deliveryId !== id) return
      // Guard against the same event being delivered twice in quick succession
      // (observed in practice; exact cause not isolated — this is a safe mitigation
      // since two legitimate distinct events never collide on this signature).
      const signature = `${data.type}|${data.nodeId}|${data.message ?? ''}`
      if (lastProgressEventRef.current === signature) return
      lastProgressEventRef.current = signature
      if (data.type === 'workspace_provisioning') {
        addTimelineEvent('WorkspaceProvisioning', 'Workspace provisioning…')
      } else if (data.type === 'workspace_provisioned') {
        addTimelineEvent('WorkspaceProvisioned', `Workspace provisioned${data.message ? ` — ${data.message}` : ''}`)
      } else if (data.type === 'git_preparing') {
        addTimelineEvent('GitPreparing', `Preparing codebase…${data.message ? ` ${data.message}` : ''}`)
      } else if (data.type === 'git_prepared') {
        addTimelineEvent('GitPrepared', `Codebase prepared${data.message ? ` — branch ${data.message}` : ''}`)
      } else if (data.type === 'step_started') {
        setLocalSteps((prev) => {
          // Mark next Pending step as Running, or create a synthetic one
          const idx = prev.findIndex((s) => s.status === 'Pending')
          if (idx !== -1) {
            const updated = [...prev]
            const step = { ...updated[idx], status: 'Running' as DeliveryStep['status'], startedAt: new Date().toISOString() }
            nodeStepMapRef.current.set(data.nodeId, step.id)
            updated[idx] = step
            return updated
          }
          return prev
        })
        addTimelineEvent('StepStarted', `${data.blockName ?? 'Step'} started`)
      } else if (data.type === 'step_completed') {
        setLocalSteps((prev) => {
          const stepId = nodeStepMapRef.current.get(data.nodeId)
          return prev.map((s) =>
            s.id === stepId || s.status === 'Running'
              ? {
                  ...s,
                  status: 'Completed' as DeliveryStep['status'],
                  completedAt: new Date().toISOString(),
                  agentOutput: {
                    ...s.agentOutput,
                    summary: data.output?.summary,
                    confidence: data.output?.confidence,
                  },
                }
              : s
          )
        })
        addTimelineEvent('StepCompleted', `${data.blockName ?? 'Step'} completed`)
      } else if (data.type === 'step_failed') {
        setLocalSteps((prev) => {
          const stepId = nodeStepMapRef.current.get(data.nodeId)
          return prev.map((s) =>
            s.id === stepId || s.status === 'Running'
              ? { ...s, status: 'Failed' as DeliveryStep['status'], errorMessage: data.message }
              : s
          )
        })
        addTimelineEvent('StepFailed', `${data.blockName ?? 'Step'} failed — ${data.message ?? ''}`)
        setLocalStatus('Failed')
        queryClient.invalidateQueries({ queryKey: ['delivery', id] })
        queryClient.invalidateQueries({ queryKey: ['deliveries'] })
      } else if (data.type === 'gate_reached') {
        setLocalSteps((prev) => {
          const stepId = nodeStepMapRef.current.get(data.nodeId)
          return prev.map((s) =>
            s.id === stepId || s.status === 'Running'
              ? {
                  ...s,
                  status: 'AwaitingHuman' as DeliveryStep['status'],
                  agentOutput: { ...s.agentOutput, humanGateReason: data.output?.summary ?? data.message },
                }
              : s
          )
        })
        addTimelineEvent('GateReached', `Gate reached — ${data.blockName ?? 'Step'}`)
        setLocalStatus('Paused')
      } else if (data.type === 'completed') {
        addTimelineEvent('DeliveryCompleted', 'Delivery completed')
        if (data.prUrl) {
          setPrUrl(data.prUrl)
          addTimelineEvent('DeliveryCompleted', `PR Created: ${data.prUrl}`)
        }
        setLocalStatus('Completed')
        queryClient.invalidateQueries({ queryKey: ['delivery', id] })
        queryClient.invalidateQueries({ queryKey: ['deliveries'] })
      } else if (data.type === 'failed') {
        addTimelineEvent('DeliveryFailed', `Delivery failed — ${data.message ?? ''}`)
        setLocalStatus('Failed')
        queryClient.invalidateQueries({ queryKey: ['delivery', id] })
        queryClient.invalidateQueries({ queryKey: ['deliveries'] })
      } else if (data.type === 'cancelled') {
        setLocalStatus('Cancelled')
        queryClient.invalidateQueries({ queryKey: ['delivery', id] })
        queryClient.invalidateQueries({ queryKey: ['deliveries'] })
      }
    }

    window.axon.executor.onProgress(handler)
    return () => window.axon.executor.offProgress(handler)
  }, [id, queryClient])


  const handleApprove = async () => {
    if (!id) return
    await approveGate.mutateAsync()
    await window.axon.executor.resume(id)
  }

  const handleReject = async () => {
    if (!id) return
    await rejectGate.mutateAsync()
    await window.axon.executor.cancel(id)
    setLocalStatus('Cancelled')
    queryClient.invalidateQueries({ queryKey: ['deliveries'] })
  }

  const handleStart = async () => {
    if (!id) return
    autoStartedRef.current = true
    setIsStarting(true)
    setLocalStatus('Running')
    try {
      const res = await window.axon.executor.start(id)
      if (!res.success) {
        setLocalStatus(null)
        toast.error(res.error ? `Failed to start delivery: ${res.error}` : 'Failed to start delivery')
      }
    } catch (err) {
      setLocalStatus(null)
      const message = err instanceof Error ? err.message : String(err)
      toast.error(`Failed to start delivery: ${message}`)
    } finally {
      setIsStarting(false)
    }
  }

  const handleStop = async () => {
    if (!id) return
    if (!window.confirm('Stop this delivery? The currently running step will be interrupted.')) return
    setIsStopping(true)
    try {
      const res = await window.axon.executor.cancel(id)
      if (!res.success) {
        toast.error(res.error ? `Failed to stop delivery: ${res.error}` : 'Failed to stop delivery')
        return
      }
      setLocalStatus('Cancelled')
      queryClient.invalidateQueries({ queryKey: ['deliveries'] })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast.error(`Failed to stop delivery: ${message}`)
    } finally {
      setIsStopping(false)
    }
  }

  const handleRetry = async () => {
    if (!delivery) return
    const actionLabel = delivery.status === 'Completed' ? 'Run this delivery again' : 'Retry this delivery'
    const workspaceWarning = delivery.workspaceType === 'Browse'
      ? 'You will be asked to pick a workspace folder again.'
      : `This reuses the same workspace folder as this delivery (keyed by ticket "${delivery.ticketId}") — any changes already in that folder will still be there unless you clear the workspace first.`
    if (!window.confirm(`${actionLabel} as a new run?\n\n${workspaceWarning}`)) return
    try {
      const newDelivery = await createDelivery.mutateAsync({
        ticketId: delivery.ticketId,
        title: delivery.title,
        pipelineId: delivery.pipelineId,
        repoUrl: delivery.repoUrl,
        workspaceType: delivery.workspaceType,
        retriedFromDeliveryId: delivery.id,
        inputs: delivery.inputs,
      })
      navigate(`/deliveries/${newDelivery.id}`)
    } catch {
      toast.error('Failed to retry delivery')
    }
  }

  const handleClearWorkspace = async () => {
    if (!delivery?.workspacePath) return
    if (displayStatus === 'Running' || displayStatus === 'Paused') {
      toast.error('Stop the delivery before clearing its workspace')
      return
    }
    if (!window.confirm(
      `Permanently delete this workspace folder?\n\n${delivery.workspacePath}\n\nThis removes the local clone and any uncommitted changes. This cannot be undone.`,
    )) return
    setIsClearingWorkspace(true)
    try {
      const res = await window.axon.workspace.clear(delivery.workspacePath)
      if (!res.success) {
        toast.error(res.error ? `Failed to clear workspace: ${res.error}` : 'Failed to clear workspace')
        return
      }
      toast.success('Workspace cleared')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast.error(`Failed to clear workspace: ${message}`)
    } finally {
      setIsClearingWorkspace(false)
    }
  }

  const addTimelineEvent = (type: TimelineEvent['type'], body: string) => {
    setTimeline((prev) => [{ type, body, timestamp: new Date().toISOString() }, ...prev].slice(0, 10))
  }

  useSignalR(id ?? null, {
    onStepStarted: (evt: StepStartedEvent) => {
      setLocalSteps((prev) =>
        prev.map((s) => s.id === evt.stepId
          ? { ...s, status: 'Running', startedAt: evt.startedAt }
          : s)
      )
      addTimelineEvent('StepStarted', `${evt.stepName} started`)
    },
    onStepCompleted: (evt: StepCompletedEvent) => {
      setLocalSteps((prev) =>
        prev.map((s) => s.id === evt.stepId
          ? { ...s, status: 'Completed', completedAt: evt.completedAt,
              agentOutput: { ...s.agentOutput, summary: evt.output } }
          : s)
      )
      addTimelineEvent('StepCompleted', `${evt.stepName} completed`)
    },
    onStepFailed: (evt: StepFailedEvent) => {
      setLocalSteps((prev) =>
        prev.map((s) => s.id === evt.stepId
          ? { ...s, status: 'Failed', errorMessage: evt.error }
          : s)
      )
      addTimelineEvent('StepFailed', `${evt.stepName} failed — ${evt.error}`)
    },
    onGateReached: (evt: GateReachedEvent) => {
      setLocalSteps((prev) =>
        prev.map((s) => s.id === evt.stepId
          ? { ...s, status: 'AwaitingHuman',
              agentOutput: { ...s.agentOutput, humanGateReason: evt.message } }
          : s)
      )
      addTimelineEvent('GateReached', `Gate reached — ${evt.stepName}`)
    },
    onDeliveryCompleted: (evt: DeliveryCompletedEvent) => {
      addTimelineEvent('DeliveryCompleted', `Delivery completed in ${evt.duration}`)
      queryClient.invalidateQueries({ queryKey: ['delivery', id] })
      queryClient.invalidateQueries({ queryKey: ['deliveries'] })
    },
    onDeliveryFailed: (evt: DeliveryFailedEvent) => {
      addTimelineEvent('DeliveryFailed', `Delivery failed — ${evt.error}`)
      queryClient.invalidateQueries({ queryKey: ['delivery', id] })
      queryClient.invalidateQueries({ queryKey: ['deliveries'] })
    },
  })

  if (isLoading || !delivery) {
    return (
      <div style={{ padding: 22 }}>
        {/* Skeleton */}
        <div style={{
          height: 50, background: 'var(--axon-bg2)', borderBottom: '1px solid var(--axon-border)',
          margin: '-22px -22px 22px', display: 'flex', alignItems: 'center', padding: '0 22px', gap: 14,
        }}>
          <div style={{ width: 90, height: 28, background: 'var(--axon-bg3)', borderRadius: 8 }} />
          <div style={{ width: 240, height: 18, background: 'var(--axon-bg3)', borderRadius: 6 }} />
        </div>
        <div style={{ height: 90, background: 'var(--axon-bg2)', border: '1px solid var(--axon-border)', borderRadius: 12, marginBottom: 16 }} />
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>
          <div>
            {[1,2,3].map((n) => (
              <div key={n} style={{ height: 80, background: 'var(--axon-bg2)', border: '1px solid var(--axon-border)', borderRadius: 8, marginBottom: 12 }} />
            ))}
          </div>
          <div style={{ height: 300, background: 'var(--axon-bg2)', border: '1px solid var(--axon-border)', borderRadius: 8 }} />
        </div>
      </div>
    )
  }

  const displayStatus = localStatus ?? delivery.status
  const completedCount = localSteps.filter((s) => s.status === 'Completed').length
  const pipelineName = delivery.pipelineSnapshot?.name ?? delivery.pipelineName
  const createdBy = delivery.createdByName ?? 'Unknown'
  // No fallback guess — the real branch name (or lack of one, e.g. no git token
  // configured) is what actually matters here, not a plausible-looking placeholder.
  const branch = delivery.branch ?? '—'
  const workspace = delivery.workspacePath
    ? delivery.workspacePath.split('/').pop()
    : undefined

  return (
    <div style={{ padding: 22 }}>
      {/* Topbar */}
      <div style={{
        height: 50, background: 'var(--axon-bg2)', borderBottom: '1px solid var(--axon-border)',
        margin: '-22px -22px 22px', display: 'flex', alignItems: 'center', padding: '0 22px', gap: 14, flexShrink: 0,
      }}>
        <button
          onClick={() => navigate('/deliveries')}
          style={{
            background: 'transparent', color: 'var(--axon-t2)',
            border: '1px solid var(--axon-border2)',
            padding: '5px 10px', borderRadius: 8, fontSize: 12, fontWeight: 600,
            cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          ← Deliveries
        </button>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--axon-t1)', flex: 1 }}>
          {delivery.ticketId}
          {delivery.title && delivery.title !== delivery.ticketId ? ` — ${delivery.title}` : ''}
        </div>
        <span style={{
          ...statusBadgeStyle(displayStatus),
          display: 'inline-flex', alignItems: 'center', gap: 3,
          fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 20, letterSpacing: '0.3px',
        }}>
          {displayStatus === 'Running' && <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'currentColor', flexShrink: 0 }} />}
          {displayStatus}
        </span>

        {displayStatus === 'Pending' && (
          <button
            onClick={handleStart}
            disabled={isStarting}
            style={{
              background: 'var(--axon-nx-glow)', color: 'var(--axon-nexus2)',
              border: '1px solid rgba(111,95,232,0.3)',
              padding: '5px 10px', borderRadius: 8, fontSize: 12, fontWeight: 600,
              cursor: isStarting ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
              opacity: isStarting ? 0.6 : 1,
            }}
          >
            {isStarting ? 'Starting…' : '▶ Start'}
          </button>
        )}

        {displayStatus === 'Running' && (
          <button
            onClick={handleStop}
            disabled={isStopping}
            style={{
              background: 'var(--axon-red-d)', color: 'var(--axon-red)',
              border: '1px solid rgba(239,68,68,0.3)',
              padding: '5px 10px', borderRadius: 8, fontSize: 12, fontWeight: 600,
              cursor: isStopping ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
              opacity: isStopping ? 0.6 : 1,
            }}
          >
            {isStopping ? 'Stopping…' : '■ Stop'}
          </button>
        )}

        {(displayStatus === 'Failed' || displayStatus === 'Cancelled' || displayStatus === 'Completed') && (
          <button
            onClick={handleRetry}
            disabled={createDelivery.isPending}
            style={{
              background: 'var(--axon-nx-glow)', color: 'var(--axon-nexus2)',
              border: '1px solid rgba(111,95,232,0.3)',
              padding: '5px 10px', borderRadius: 8, fontSize: 12, fontWeight: 600,
              cursor: createDelivery.isPending ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
              opacity: createDelivery.isPending ? 0.6 : 1,
            }}
          >
            {createDelivery.isPending
              ? (displayStatus === 'Completed' ? 'Starting…' : 'Retrying…')
              : (displayStatus === 'Completed' ? '↻ Run Again' : '↻ Retry')}
          </button>
        )}
      </div>

      {/* RRA Banner — only when pipeline includes an RRA step */}
      {localSteps.some((s) => s.name.includes('RRA') || s.nodeName?.includes('RRA')) && (
        <RraBanner steps={localSteps} />
      )}

      {/* Main grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>
        {/* Left: pipeline graph */}
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--axon-t1)', marginBottom: 10 }}>
            Pipeline Execution
          </div>
          <div style={{
            display: 'flex', gap: 8, marginBottom: 10, fontSize: 10, color: 'var(--axon-t3)',
          }}>
            {([
              ['Pending', '#64748b'], ['Running', '#3b82f6'], ['Success', '#22c55e'],
              ['Needs Human', '#f59e0b'], ['Failed', '#ef4444'],
            ] as const).map(([label, color]) => (
              <span key={label} style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                background: 'var(--axon-bg2)', border: '1px solid var(--axon-border)',
                borderRadius: 20, padding: '3px 9px',
              }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
                {label}
              </span>
            ))}
          </div>
          <div style={{
            height: 480, background: '#0f1117', border: '1px solid var(--axon-border)',
            borderRadius: 12, overflow: 'hidden', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.02)',
          }}>
            <ReactFlowProvider>
              <ReactFlow
                nodes={flowNodes}
                edges={flowEdges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable
                onNodeClick={onNodeClick}
                onPaneClick={onPaneClick}
                fitView
                proOptions={{ hideAttribution: true }}
                style={{ background: '#0f1117' }}
              >
                <Background color="#1e293b" gap={20} />
                <Controls showInteractive={false} />
                <MiniMap
                  style={{ background: '#111827', border: '1px solid #1e293b' }}
                  nodeColor="#334155"
                  pannable
                  zoomable
                />
              </ReactFlow>
            </ReactFlowProvider>
          </div>
        </div>

        {/* Right: node detail (when selected) or Signals + Job details */}
        <div>
          {selectedStep && selectedNode ? (
            <div style={{
              background: 'var(--axon-bg2)', border: '1px solid var(--axon-border)',
              borderRadius: 12, padding: '16px', marginBottom: 16,
              boxShadow: '0 4px 24px rgba(0,0,0,0.18)',
            }}>
              {/* Header: role icon, name, role label */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {selectedBlock?.role && (
                    <div style={{
                      width: 34, height: 34, borderRadius: 8, flexShrink: 0,
                      background: 'var(--axon-bg3)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <img src={getBlockTypeIcon(selectedBlock.role)} alt={selectedBlock.role} style={{ width: 22, height: 22 }} />
                    </div>
                  )}
                  <div>
                    <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--axon-t1)', lineHeight: 1.3 }}>
                      {selectedStep.nodeName ?? selectedStep.name}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                      <span style={{ fontSize: 10.5, color: 'var(--axon-t3)' }}>{selectedBlock?.role ?? '—'}</span>
                      {selectedBlock?.agentRuntime && (
                        <>
                          <span style={{ color: 'var(--axon-t4)', fontSize: 9 }}>·</span>
                          <img src={getRuntimeIcon(selectedBlock.agentRuntime)} alt={selectedBlock.agentRuntime} style={{ width: 12, height: 12, borderRadius: 3 }} />
                          <span style={{ fontSize: 10.5, color: 'var(--axon-t3)' }}>{RUNTIME_LABELS[selectedBlock.agentRuntime]}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
                <button onClick={() => setSelectedNodeId(null)} style={{
                  background: 'transparent', border: 'none', color: 'var(--axon-t3)', cursor: 'pointer', fontSize: 16,
                  width: 24, height: 24, borderRadius: 6, flexShrink: 0,
                }}>✕</button>
              </div>

              {/* Status row */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10, fontSize: 10.5, color: 'var(--axon-t3)',
                marginBottom: 14, background: 'var(--axon-bg3)', borderRadius: 8, padding: '8px 11px',
              }}>
                <span style={{
                  ...statusBadgeStyle(selectedStep.status === 'AwaitingHuman' ? 'Paused' : selectedStep.status === 'Completed' ? 'Completed' : selectedStep.status),
                  fontSize: 9.5, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
                }}>
                  {selectedStep.status}
                </span>
                {selectedStep.startedAt && <span>Started <b style={{ color: 'var(--axon-t1)', fontWeight: 600 }}>{new Date(selectedStep.startedAt).toLocaleTimeString()}</b></span>}
                {selectedStep.startedAt && selectedStep.completedAt && (
                  <span>Duration <b style={{ color: 'var(--axon-t1)', fontWeight: 600 }}>{formatTotalDuration(selectedStep.startedAt, selectedStep.completedAt)}</b></span>
                )}
              </div>

              {/* Summary — quick TL;DR, shown prominently up top */}
              {selectedStep.agentOutput?.summary && (
                <div style={{
                  borderLeft: '2px solid var(--axon-nexus2)', paddingLeft: 10,
                  fontSize: 11.5, color: 'var(--axon-t2)', lineHeight: 1.5, marginBottom: 14, fontStyle: 'italic',
                }}>
                  “{selectedStep.agentOutput.summary}”
                </div>
              )}

              {selectedStep.status === 'AwaitingHuman' && (
                <div style={{
                  background: 'var(--axon-amber-d)', border: '1px solid rgba(245,158,11,0.3)',
                  borderRadius: 8, padding: 11, marginBottom: 14,
                }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--axon-amber)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    ⚠ Human Gate Reason
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--axon-t2)', lineHeight: 1.5, marginBottom: isSelectedNodeActiveGate ? 10 : 0 }}>
                    {selectedStep.agentOutput?.humanGateReason ?? 'Human review required before proceeding.'}
                  </div>
                  {isSelectedNodeActiveGate && (
                    <div style={{ display: 'flex', gap: 7 }}>
                      <button onClick={handleApprove} style={{
                        background: 'var(--axon-green-d)', color: 'var(--axon-green)', border: '1px solid rgba(16,185,129,0.25)',
                        padding: '6px 12px', borderRadius: 8, fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                      }}>✓ Approve &amp; Continue</button>
                      <button onClick={handleReject} style={{
                        background: 'var(--axon-red-d)', color: 'var(--axon-red)', border: '1px solid rgba(239,68,68,0.25)',
                        padding: '6px 12px', borderRadius: 8, fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                      }}>✕ Reject Delivery</button>
                    </div>
                  )}
                </div>
              )}

              {selectedStep.status === 'Failed' && (
                <div style={{
                  background: 'var(--axon-red-d)', border: '1px solid rgba(239,68,68,0.3)',
                  borderRadius: 8, padding: 11, marginBottom: 14,
                }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--axon-red)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    ✕ Error
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--axon-t2)', lineHeight: 1.5 }}>
                    {selectedStep.errorMessage ?? 'An error occurred during this step.'}
                  </div>
                </div>
              )}

              {/* Input */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 7 }}>
                <span style={{ color: 'var(--axon-nexus2)', fontSize: 11 }}>↓</span>
                <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--axon-t3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Input <span style={{ color: 'var(--axon-t4)', fontWeight: 500 }}>(Context)</span>
                </span>
              </div>
              {selectedStep.isContextTruncated ? (
                <button onClick={() => viewFullFile(selectedStep.contextFileRef!, 'Input — full context')} style={{
                  background: 'var(--axon-bg3)', border: '1px dashed var(--axon-border2)', color: 'var(--axon-t2)',
                  borderRadius: 8, padding: '8px 10px', fontSize: 10.5, cursor: 'pointer', fontFamily: 'inherit', width: '100%', textAlign: 'left', marginBottom: 14,
                }}>
                  ⚠ Input too large — view full content in workspace
                </button>
              ) : (
                <div style={{
                  background: 'var(--axon-bg3)', border: '1px solid var(--axon-border)', borderRadius: 8,
                  marginBottom: 14, fontSize: 10.5, overflow: 'hidden',
                }}>
                  {selectedStep.contextSnapshot && Object.keys(selectedStep.contextSnapshot).length > 0 ? (
                    Object.entries(selectedStep.contextSnapshot).map(([k, v], i) => (
                      <div key={k} style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
                        padding: '7px 10px', background: i % 2 === 1 ? 'rgba(255,255,255,0.02)' : 'transparent',
                      }}>
                        <span style={{ color: 'var(--axon-t3)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>{k}</span>
                        <span title={JSON.stringify(v)} style={{
                          color: 'var(--axon-teal)', fontFamily: 'var(--font-mono)', background: 'var(--axon-bg2)',
                          borderRadius: 5, padding: '2px 7px', textAlign: 'right', overflow: 'hidden',
                          textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180,
                        }}>{JSON.stringify(v)}</span>
                      </div>
                    ))
                  ) : selectedBlock?.contextRequirements && selectedBlock.contextRequirements.length > 0 ? (
                    <div style={{ padding: '9px 10px', color: 'var(--axon-amber)' }}>
                      ⚠ Required but not available: {selectedBlock.contextRequirements.join(', ')}
                    </div>
                  ) : (
                    <div style={{ padding: '9px 10px', color: 'var(--axon-t4)' }}>(no context fields required)</div>
                  )}
                </div>
              )}

              {/* Output */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 7 }}>
                <span style={{ color: 'var(--axon-green)', fontSize: 11 }}>↑</span>
                <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--axon-t3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Output <span style={{ color: 'var(--axon-t4)', fontWeight: 500 }}>(Result)</span>
                </span>
              </div>
              {selectedStep.agentOutput?.isTruncated ? (
                <button onClick={() => viewFullFile(selectedStep.agentOutput!.outputFileRef!, 'Output — full result')} style={{
                  background: 'var(--axon-bg3)', border: '1px dashed var(--axon-border2)', color: 'var(--axon-t2)',
                  borderRadius: 8, padding: '8px 10px', fontSize: 10.5, cursor: 'pointer', fontFamily: 'inherit', width: '100%', textAlign: 'left', marginBottom: 14,
                }}>
                  ⚠ Output too large — view full content in workspace
                </button>
              ) : (
                <div style={{
                  background: 'var(--axon-bg3)', border: '1px solid var(--axon-border)', borderRadius: 8,
                  marginBottom: 14, fontSize: 10.5, overflow: 'hidden',
                }}>
                  {selectedStep.agentOutput?.result && Object.keys(selectedStep.agentOutput.result).length > 0 ? (
                    Object.entries(selectedStep.agentOutput.result).map(([k, v], i) => (
                      <div key={k} style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
                        padding: '7px 10px', background: i % 2 === 1 ? 'rgba(255,255,255,0.02)' : 'transparent',
                      }}>
                        <span style={{ color: 'var(--axon-t3)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>{k}</span>
                        <span title={JSON.stringify(v)} style={{
                          color: 'var(--axon-teal)', fontFamily: 'var(--font-mono)', background: 'var(--axon-bg2)',
                          borderRadius: 5, padding: '2px 7px', textAlign: 'right', overflow: 'hidden',
                          textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180,
                        }}>{JSON.stringify(v)}</span>
                      </div>
                    ))
                  ) : (
                    <div style={{ padding: '9px 10px', color: 'var(--axon-t4)' }}>(no result yet)</div>
                  )}
                </div>
              )}

              {selectedStep.agentOutput?.confidence != null && (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--axon-t3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      Confidence
                    </span>
                    <span style={{
                      fontSize: 11, fontWeight: 700,
                      color: selectedStep.agentOutput.confidence >= 0.7 ? 'var(--axon-green)' : 'var(--axon-amber)',
                    }}>
                      {Math.round(selectedStep.agentOutput.confidence * 100)}%
                    </span>
                  </div>
                  <div style={{ height: 6, background: 'var(--axon-bg3)', borderRadius: 4, overflow: 'hidden' }}>
                    <div style={{
                      height: '100%', width: `${Math.round(selectedStep.agentOutput.confidence * 100)}%`,
                      background: selectedStep.agentOutput.confidence >= 0.7 ? 'var(--axon-green)' : 'var(--axon-amber)',
                      borderRadius: 4, transition: 'width 0.3s ease',
                    }} />
                  </div>
                  {selectedStep.agentOutput.confidence < 0.7 && (
                    <div style={{ fontSize: 9.5, color: 'var(--axon-amber)', marginTop: 4 }}>
                      ⚠ Below threshold (70%)
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : null}

          <div style={{ display: selectedStep ? 'none' : 'block' }}>
          {/* Job Details */}
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--axon-t1)', marginBottom: 8 }}>
            Job Details
          </div>
          <div style={{
            background: 'var(--axon-bg2)', border: '1px solid var(--axon-border)',
            borderRadius: 12, padding: '12px 14px', fontSize: 11, marginBottom: 16,
          }}>
            {[
              ...(delivery.jobNumber ? [{ k: 'Job', v: `#${delivery.jobNumber}` }] : []),
              { k: 'Pipeline', v: pipelineName },
              { k: 'Triggered by', v: createdBy },
              { k: 'Repo', v: delivery.repoUrl, mono: true },
              { k: 'Workspace', v: workspace ?? delivery.workspaceType, mono: !!workspace },
              { k: 'Branch', v: branch, mono: true },
              { k: 'Step', v: `${completedCount} of ${localSteps.length}` },
              ...(delivery.attemptNumber && delivery.attemptNumber > 1
                ? [{ k: 'Attempt', v: `#${delivery.attemptNumber}` }]
                : []),
            ].map(({ k, v, mono }, i, arr) => (
              <div key={k} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '5px 0', fontSize: 11,
                borderBottom: i < arr.length - 1 ? '1px solid var(--axon-border)' : 'none',
              }}>
                <span style={{ color: 'var(--axon-t3)' }}>{k}</span>
                <span style={{
                  color: 'var(--axon-t1)', fontWeight: 500,
                  fontFamily: mono ? 'var(--font-mono)' : 'inherit',
                  fontSize: mono ? 10 : 11,
                }}>
                  {v}
                </span>
              </div>
            ))}
          </div>

          {delivery.retriedFromDeliveryId && (
            <button
              onClick={() => navigate(`/deliveries/${delivery.retriedFromDeliveryId}`)}
              style={{
                background: 'transparent', color: 'var(--axon-t3)',
                border: 'none', padding: '6px 0', fontSize: 10.5,
                cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
              }}
            >
              ← View previous attempt
            </button>
          )}

          {delivery.workspacePath && displayStatus !== 'Running' && displayStatus !== 'Paused' && (
            <button
              onClick={handleClearWorkspace}
              disabled={isClearingWorkspace}
              style={{
                background: 'transparent', color: 'var(--axon-red)',
                border: '1px solid rgba(239,68,68,0.25)',
                padding: '6px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600,
                cursor: isClearingWorkspace ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
                width: '100%', marginTop: 10, marginBottom: 16,
                opacity: isClearingWorkspace ? 0.6 : 1,
              }}
            >
              {isClearingWorkspace ? 'Clearing…' : '🗑 Clear workspace'}
            </button>
          )}

          {/* Completion Cards */}
          {displayStatus === 'Completed' && (
            <>
              {prUrl && (
                <div style={{
                  background: 'var(--axon-green-d)', border: '1px solid rgba(16,185,129,0.2)',
                  borderRadius: 12, padding: '12px 14px', marginBottom: 16,
                }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--axon-green)', marginBottom: 8 }}>
                    ✓ PR Created
                  </div>
                  <button
                    onClick={async () => {
                      await window.axon.shell.openExternal(prUrl)
                    }}
                    style={{
                      background: 'transparent', color: 'var(--axon-green)',
                      border: '1px solid rgba(16,185,129,0.3)',
                      padding: '6px 10px', borderRadius: 6, fontSize: 11, fontWeight: 500,
                      cursor: 'pointer', fontFamily: 'inherit', width: '100%', textAlign: 'left',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}
                    title={prUrl}
                  >
                    {prUrl.split('/').pop()} ↗
                  </button>
                </div>
              )}
              <div style={{
                background: 'var(--axon-bg2)', border: '1px solid var(--axon-border)',
                borderRadius: 12, padding: '12px 14px', marginBottom: 16,
              }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--axon-t1)', marginBottom: 8 }}>
                  Duration
                </div>
                <div style={{ fontSize: 11, color: 'var(--axon-t2)' }}>
                  {formatTotalDuration(delivery.startedAt, delivery.completedAt)}
                </div>
              </div>
            </>
          )}

          {/* Timeline — compact, one line per event. Not labeled "Live" since this
              same feed shows reconstructed history on a delivery you're just viewing,
              not actively running. */}
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--axon-t1)', marginBottom: 10 }}>
            Timeline
          </div>
          {timeline.length === 0 ? (
            <div style={{
              background: 'var(--axon-bg3)', border: '1px solid var(--axon-border)',
              borderRadius: 6, padding: '7px 10px',
            }}>
              <div style={{ fontSize: 11, color: 'var(--axon-t4)' }}>
                Waiting for events…
              </div>
            </div>
          ) : (
            timeline.map((sig, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 6,
                background: 'var(--axon-bg3)', border: '1px solid var(--axon-border)',
                borderRadius: 6, padding: '5px 9px', marginBottom: 4, fontSize: 10.5,
                overflow: 'hidden',
              }}>
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: eventTypeColor[sig.type], flexShrink: 0 }} />
                <span style={{
                  fontSize: 9, fontWeight: 700, textTransform: 'uppercase', flexShrink: 0,
                  color: eventTypeColor[sig.type],
                }}>
                  {sig.type}
                </span>
                <span style={{
                  color: 'var(--axon-t2)', flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {sig.body}
                </span>
                <span style={{ fontSize: 9, color: 'var(--axon-t4)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>
                  {timeAgo(sig.timestamp)}
                </span>
              </div>
            ))
          )}
          </div>
        </div>
      </div>

      {fullFileContent && (
        <div
          onClick={() => setFullFileContent(null)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 50,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--axon-bg2)', border: '1px solid var(--axon-border)',
              borderRadius: 12, width: 640, maxHeight: '80vh', display: 'flex', flexDirection: 'column',
            }}
          >
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '12px 16px', borderBottom: '1px solid var(--axon-border)',
            }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--axon-t1)' }}>{fullFileContent.title}</div>
              <button onClick={() => setFullFileContent(null)} style={{
                background: 'transparent', border: 'none', color: 'var(--axon-t3)', cursor: 'pointer', fontSize: 16,
              }}>✕</button>
            </div>
            <pre style={{
              margin: 0, padding: 16, overflow: 'auto', fontSize: 11, fontFamily: 'var(--font-mono)',
              color: 'var(--axon-t2)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>
              {fullFileContent.content}
            </pre>
          </div>
        </div>
      )}

      <style>{`
        @keyframes axon-step-glow {
          0%, 100% { box-shadow: 0 0 0 0 var(--axon-nx-glow); }
          50% { box-shadow: 0 0 0 5px transparent; }
        }
        @keyframes axon-node-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.75; }
        }
        @keyframes axon-node-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}
