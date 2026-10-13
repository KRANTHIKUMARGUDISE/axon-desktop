import '@xyflow/react/dist/style.css'
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQueryClient, useQuery } from '@tanstack/react-query'
import {
  ReactFlow, ReactFlowProvider, Background, Controls, Panel,
  type Node, type Edge, type NodeTypes, type EdgeTypes, type ReactFlowInstance,
} from '@xyflow/react'
import { useDelivery, useApproveGate, useRejectGate, useCreateDelivery } from '../hooks/useDeliveries'
import { getStepContext, getStepOutput } from '../services/deliveriesService'
import { getBlocks } from '../services/blocksService'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs'
import { Card, CardContent } from '../components/ui/card'
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip'
import { Separator } from '../components/ui/separator'
import RawDataViewerModal from '../components/shared/RawDataViewerModal'
import type { DeliveryStep, DeliveryEvent, BuildingBlock } from '../types'
import RraBanner from '../components/delivery/RraBanner'
import RerunDialog from '../components/delivery/RerunDialog'
import type { RerunReason } from '@shared'
import DecisionNode from '../components/pipeline/nodes/DecisionNode'
import ExecutionNode from '../components/pipeline/nodes/ExecutionNode'
import KnowledgeNode from '../components/pipeline/nodes/KnowledgeNode'
import ControlNode from '../components/pipeline/nodes/ControlNode'
import IONode from '../components/pipeline/nodes/IONode'
import UtilityNode from '../components/pipeline/nodes/UtilityNode'
import ForEachNode from '../components/pipeline/nodes/ForEachNode'
import { ForEachChips, ForEachTable, ItemPanel, ItemSwitcher, defaultLane } from '../components/delivery/ForEachPanels'
import type { UIProgress } from '../components/delivery/ForEachPanels'
import { forEachProgress, forEachSourceLabel, showConfidence, contextKey, isOptionalContext } from '@shared'
import ConditionalEdge from '../components/pipeline/ConditionalEdge'
import { getBlockTypeIcon } from '../utils/blockTypeIcons'
import { getRuntimeIcon, RUNTIME_LABELS } from '../utils/runtimeIcons'
import type { ExecutionStatus } from '../components/pipeline/nodes/BaseNode'
import { toast } from 'sonner'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '../components/ui/collapsible'
import { ChevronRight, FolderOpen, Code2 } from 'lucide-react'

type AvailabilityStatus = 'available' | 'missing' | 'empty'

function availabilityChipClass(status: AvailabilityStatus | undefined): string {
  return status === 'available' ? 'border-emerald-600/30 bg-emerald-500/10 text-emerald-500'
    : status === 'empty' ? 'border-amber-600/30 bg-amber-500/10 text-amber-500'
      : status === 'missing' ? 'border-red-600/30 bg-red-500/10 text-red-500'
        : 'text-muted-foreground'
}

// Declared fields (from the block's own schema) always render as named chips.
// Anything else actually present in the availability map — i.e. sent to the
// agent despite not being declared — is real signal worth knowing about, but
// showing every undeclared key by default would be noisy/unbounded for blocks
// that send a whole upstream blob with no schema. So it collapses behind a
// single "+N other fields" disclosure instead, expanded only on click.
function FieldAvailabilityChips({
  declaredFields,
  availability,
  emptyLabel,
  verb = 'sent',
}: {
  declaredFields: string[] | undefined
  availability: Record<string, AvailabilityStatus> | undefined
  emptyLabel: string
  verb?: 'sent' | 'returned'
}) {
  const declared = declaredFields ?? []
  const declaredSet = new Set(declared.map(contextKey))
  const extraKeys = Object.keys(availability ?? {}).filter((k) => !declaredSet.has(k))

  if (declared.length === 0 && extraKeys.length === 0) {
    return <span style={{ fontSize: 10.5, color: 'var(--axon-t4)' }}>{emptyLabel}</span>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {declared.map((raw) => {
          const field = contextKey(raw)
          const status = availability?.[field]
          return (
            <Badge key={raw} variant="outline" className={availabilityChipClass(status)}>
              {field}{status ? ` · ${status}` : isOptionalContext(raw) ? ' · optional' : ''}
            </Badge>
          )
        })}
      </div>
      {extraKeys.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="group/extra-fields flex cursor-pointer items-center gap-1 text-left" style={{ fontSize: 10.5, color: 'var(--axon-t3)' }}>
            <ChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]/extra-fields:rotate-90" />
            +{extraKeys.length} undeclared field{extraKeys.length === 1 ? '' : 's'} also {verb} — click to view
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-1.5 flex flex-wrap gap-1.5">
            {extraKeys.map((field) => {
              const status = availability?.[field]
              return (
                <Badge key={field} variant="outline" className={availabilityChipClass(status)}>
                  {field}{status ? ` · ${status}` : ''}
                </Badge>
              )
            })}
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  )
}

const nodeTypes: NodeTypes = {
  forEachNode: ForEachNode,
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
    case 'AwaitingApproval': return 'AwaitingApproval'
    default: return 'Pending'
  }
}

interface TimelineEvent {
  type:
    | 'WorkspaceProvisioning' | 'WorkspaceProvisioned'
    | 'GitPreparing' | 'GitPrepared'
    | 'StepStarted' | 'StepCompleted' | 'StepFailed' | 'GateReached'
    | 'DeliveryCompleted' | 'DeliveryFailed' | 'DeliveryInterrupted'
    | 'GateApproved' | 'GateRejected'
  body: string
  timestamp: string
  /** Clicking the entry selects this node (+ ForEach item). `item: true` opens the item panel instead. */
  target?: { nodeId: string; itemKey?: string; item?: boolean }
}

const eventTypeLabel: Record<TimelineEvent['type'], string> = {
  WorkspaceProvisioning: 'Workspace', WorkspaceProvisioned: 'Workspace', GitPreparing: 'Git', GitPrepared: 'Git',
  StepStarted: 'Started', StepCompleted: 'Completed', StepFailed: 'Failed', GateReached: 'Approval needed',
  DeliveryCompleted: 'Delivery done', DeliveryFailed: 'Delivery failed', DeliveryInterrupted: 'Delivery stopped',
  GateApproved: 'Approved', GateRejected: 'Rejected',
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
  DeliveryInterrupted: 'var(--axon-amber)',
  GateApproved: 'var(--axon-green)',
  GateRejected: 'var(--axon-red)',
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
    case 'Interrupted':
    case 'Paused': return { background: 'var(--axon-amber-d)', color: 'var(--axon-amber)', border: '1px solid rgba(245,158,11,0.2)' }
    case 'Completed': return { background: 'var(--axon-green-d)', color: 'var(--axon-green)', border: '1px solid rgba(16,185,129,0.2)' }
    case 'Failed': return { background: 'var(--axon-red-d)', color: 'var(--axon-red)', border: '1px solid rgba(239,68,68,0.2)' }
    case 'Pending': return { background: 'rgba(100,116,139,0.12)', color: 'var(--axon-t3)', border: '1px solid rgba(100,116,139,0.2)' }
    default: return { background: 'var(--axon-bg3)', color: 'var(--axon-t2)', border: '1px solid var(--axon-border2)' }
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
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
  const queryClient = useQueryClient()

  const { data: delivery, isLoading, refetch } = useDelivery(id ?? '')
  const approveGate = useApproveGate(id ?? '')
  const rejectGate = useRejectGate(id ?? '')
  const createDelivery = useCreateDelivery()

  const [localSteps, setLocalSteps] = useState<DeliveryStep[]>([])
  const [timeline, setTimeline] = useState<TimelineEvent[]>([])
  const [localStatus, setLocalStatus] = useState<string | null>(null)
  // Live-updated from workspace_provisioned/git_prepared progress events — the backend
  // record's own workspacePath/branch only land on the next full delivery refetch, which
  // could be a while away (periodic poll only runs once status reads Running, and a
  // refetch isn't otherwise triggered by these specific events).
  const [localWorkspacePath, setLocalWorkspacePath] = useState<string | null>(null)
  const [, setLocalBranch] = useState<string | null>(null)
  const [prUrl, setPrUrl] = useState<string | null>(null)
  const [isStarting, setIsStarting] = useState(false)
  const [rerunOpen, setRerunOpen] = useState(false)
  const [isStopping, setIsStopping] = useState(false)
  const [isClearingWorkspace, setIsClearingWorkspace] = useState(false)
  const [workspaceBytes, setWorkspaceBytes] = useState<number | null>(null)
  const [blocks, setBlocks] = useState<BuildingBlock[]>([])
  // A node id, or "item:<forEachId>::<itemKey>" for a ForEach item panel.
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  // Which ForEach item a selected body node shows (null = the running one, else the last).
  const [selectedItemKey, setSelectedItemKey] = useState<string | null>(null)
  // The step panel is split into Overview / Input / Output so it stays readable.
  const [panelTab, setPanelTab] = useState<'overview' | 'input' | 'output'>('overview')
  const [gateComment, setGateComment] = useState('')
  const [viewerData, setViewerData] = useState<{ title: string; data: string | Record<string, unknown> } | null>(null)
  const [viewerLoading, setViewerLoading] = useState(false)
  const autoStartedRef = useRef(false)
  const lastProgressEventRef = useRef<{ signature: string; at: number } | null>(null)
  const seededDeliveryIdRef = useRef<string | null>(null)
  const reactFlowInstanceRef = useRef<ReactFlowInstance | null>(null)

  // Reset all per-delivery local state when navigating to a different delivery
  // (e.g. via Retry) without a full component remount.
  useEffect(() => {
    if (seededDeliveryIdRef.current !== null && seededDeliveryIdRef.current !== id) {
      setLocalSteps([])
      setTimeline([])
      setLocalStatus(null)
      setLocalWorkspacePath(null)
      setLocalBranch(null)
      lastProgressEventRef.current = null
      autoStartedRef.current = false
    }
    seededDeliveryIdRef.current = id ?? null
  }, [id])

  // Sync localSteps from initial fetch + auto-start.
  // Once the backend has persisted steps (run finished), that's the source of truth for
  // those specific nodes — but it only ever covers nodes that have already run. Merge
  // persisted steps into one entry per pipeline node rather than replacing the array
  // wholesale: a wholesale replace would drop the Pending/Running placeholders for nodes
  // further down the pipeline that haven't persisted yet (e.g. right after a gate step
  // persists as AwaitingApproval), and once dropped, the live step_started/completed
  // handlers below — which use .map() to flip an existing entry's status — become no-ops
  // for those nodes since there's nothing left in the array for them to match.
  useEffect(() => {
    if (!delivery) return
    // NOTE: localStatus is intentionally NOT reset here. This effect re-runs on every
    // delivery refetch (e.g. the periodic 5s poll), not just on first load — clearing an
    // optimistic 'Running' override (set by handleStart) here would race against the
    // backend's own status update still being in flight, flickering the UI back to
    // "Pending". localStatus is only reset on an actual delivery-id change (above) or
    // explicitly superseded by a definitive event (step/gate/completed/failed handlers).
    if (delivery.prUrl) {
      setPrUrl(delivery.prUrl)
    }

    const pipelineNodes = delivery.pipelineSnapshot?.nodes ?? []
    const nodeLabelById = new Map(pipelineNodes.map((n) => [n.id, n.label]))
    // The backend's persisted DeliveryStep only carries `nodeId`/`blockName` — there is
    // no `id`/`name`/`nodeName` field on the wire. Always derive `id` from `nodeId` and
    // the display label from the pipeline snapshot's node.label, so step lookup by node
    // id and the title don't silently go blank/unmatched on a reloaded delivery.
    const persistedByNodeId = new Map(
      delivery.steps.filter((s) => !s.itemKey).map((s) => [s.nodeId ?? s.id, { ...s, id: s.nodeId ?? s.id, nodeName: nodeLabelById.get(s.nodeId ?? s.id) ?? s.nodeName ?? s.name }])
    )

    if (pipelineNodes.length > 0) {
      setLocalSteps((prev) => {
        const prevById = new Map(prev.map((s) => [s.id, s]))
        const itemSteps = delivery.steps.filter((s) => s.itemKey).map((s) => ({ ...s, nodeName: nodeLabelById.get(s.nodeId ?? s.id) ?? s.nodeName ?? s.name }))
        return [...pipelineNodes.map((n) =>
          persistedByNodeId.get(n.id)
            // Not yet persisted — keep whatever live progress we already have locally
            // (e.g. Running from a step_started event), else seed a fresh Pending entry.
            ?? prevById.get(n.id)
            ?? { id: n.id, name: n.label ?? n.id, nodeName: n.label ?? n.id, status: 'Pending' as DeliveryStep['status'] }
        ), ...itemSteps]
      })
    } else if (delivery.steps.length > 0) {
      // No pipelineSnapshot.nodes available (shouldn't normally happen) — fall back to
      // exactly whatever the backend persisted.
      setLocalSteps(Array.from(persistedByNodeId.values()))
    }

    if (delivery.steps.length > 0) {
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
            synthesized.push({ type: 'StepStarted', body: `${step.nodeName ?? step.name}${step.itemKey ? ` [${step.itemKey}]` : ''} started`, timestamp: step.startedAt, target: { nodeId: step.nodeId ?? step.id, itemKey: step.itemKey ?? undefined } })
          }
          if (step.completedAt || step.status === 'Completed' || step.status === 'Failed') {
            const ts = step.completedAt ?? step.startedAt ?? delivery.startedAt
            synthesized.push(
              step.status === 'Failed'
                ? { type: 'StepFailed', body: `${step.nodeName ?? step.name}${step.itemKey ? ` [${step.itemKey}]` : ''} failed — ${step.errorMessage ?? ''}`, timestamp: ts, target: { nodeId: step.nodeId ?? step.id, itemKey: step.itemKey ?? undefined } }
                : { type: 'StepCompleted', body: `${step.nodeName ?? step.name}${step.itemKey ? ` [${step.itemKey}]` : ''} completed`, timestamp: ts, target: { nodeId: step.nodeId ?? step.id, itemKey: step.itemKey ?? undefined } }
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

  // Repos used by this delivery, derived in main from the recorded step folders (branch + PR link when known).
  const { data: repoInfo } = useQuery({
    queryKey: ['delivery-repos', id, delivery?.status, delivery?.steps.length, delivery?.prUrls?.length],
    queryFn: () => window.axon.delivery.repos(id as string),
    enabled: !!id && !!delivery,
  })

  const deliveryFolderPath = delivery?.deliveryFolder ?? localWorkspacePath ?? delivery?.workspacePath ?? undefined

  const progresses = useMemo(
    () => (delivery
      ? forEachProgress({
        steps: delivery.steps as (DeliveryStep & { nodeId: string })[],
        itemPlan: delivery.itemPlan,
        pipelineSnapshot: delivery.pipelineSnapshot,
      })
      : []),
    [delivery],
  )

  const flowNodes: Node[] = useMemo(() => {
    const nodes = delivery?.pipelineSnapshot?.nodes ?? []
    // Parents must precede children for xyflow sub-flows.
    const ordered = [...nodes.filter((n) => !n.parentId), ...nodes.filter((n) => n.parentId)]
    return ordered.map((n) => {
      if (n.type === 'forEach') {
        const progress = progresses.find((p) => p.nodeId === n.id)
        const own = localSteps.find((s) => s.id === n.id)
        const status: ExecutionStatus | undefined = progress?.failed ? 'Failed' : stepStatusToExecutionStatus(own?.status)
        const base = n.size ?? { width: 420, height: 220 }
        return {
          id: n.id,
          type: 'forEachNode',
          position: n.position,
          draggable: false,
          connectable: false,
          zIndex: -1,
          style: { width: base.width, height: base.height }, // keeps its designed size: the items are a compact chip row, not expanding lanes
          data: {
            label: n.label ?? n.name ?? 'ForEach',
            sourceLabel: forEachSourceLabel(n.id, delivery?.pipelineSnapshot?.nodes ?? [], delivery?.pipelineSnapshot?.edges ?? []) ?? null, maxItems: n.maxItems,
            hideHandles: true, resizable: false,
            counter: progress ? progress.counter : undefined,
            executionStatus: status,
            lanes: progress ? (
              <ForEachChips
                progress={progress as UIProgress}
                selectedKey={selectedNodeId?.startsWith(`item:${n.id}::`) ? selectedNodeId.slice(`item:${n.id}::`.length) : null}
                onSelectItem={(key) => { setSelectedNodeId(`item:${n.id}::${key}`); setGateComment('') }}
              />
            ) : undefined,
          },
        }
      }
      const block = blockMap.get(n.blockId)
      const nodeType = block?.role ?? 'Execution'
      const typeKey = nodeType.toLowerCase()
      // Inside a ForEach a node's status is that of the current item's step (the lanes show every item).
      const progress = n.parentId ? progresses.find((p) => p.nodeId === n.parentId) : undefined
      const lane = progress ? (progress.lanes.find((l) => l.key === progress.currentKey) ?? progress.lanes[progress.lanes.length - 1]) : undefined
      const step = n.parentId ? lane?.steps.find((s) => s.nodeId === n.id) : localSteps.find((s) => s.id === n.id)
      return {
        id: n.id,
        type: typeKey === 'io' ? 'ionode' : `${typeKey}Node`,
        position: n.position,
        ...(n.parentId ? { parentId: n.parentId } : {}),
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
  }, [delivery, blockMap, localSteps, progresses, selectedNodeId])

  // `fitView` on <ReactFlow> only auto-fits once, at initial mount. If this
  // component instance is reused (e.g. retrying a delivery without a full
  // remount) or `delivery`/`blocks` resolve after the canvas already
  // initialized, nodes that show up later can end up positioned outside the
  // viewport that was fitted to the smaller/earlier node set — present in
  // `flowNodes` but effectively invisible until something re-fits the view.
  // Re-fit explicitly whenever the node count changes.
  useEffect(() => {
    if (flowNodes.length > 0) {
      reactFlowInstanceRef.current?.fitView()
    }
  }, [flowNodes.length])

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

  const snapshotNodes = delivery?.pipelineSnapshot?.nodes ?? []
  const itemSel = selectedNodeId?.startsWith('item:')
    ? (() => { const rest = selectedNodeId.slice(5); const k = rest.indexOf('::'); return { feId: rest.slice(0, k), key: rest.slice(k + 2) } })()
    : null
  const selectedBaseId = itemSel ? undefined : selectedNodeId ?? undefined
  const selectedDef = snapshotNodes.find((n) => n.id === selectedBaseId)
  const selectedNode = flowNodes.find((n) => n.id === selectedBaseId)
  const selectedBlock = selectedNode ? blockMap.get((selectedNode.data as { blockId: string }).blockId) : undefined
  // A node inside a ForEach shows ONE item at a time (switcher on top): the chosen one, else running, else the last.
  const bodyProgress = selectedDef?.parentId ? (progresses.find((p) => p.nodeId === selectedDef.parentId) as UIProgress | undefined) : undefined
  const activeItemKey = bodyProgress
    ? (selectedItemKey && bodyProgress.lanes.some((l) => l.key === selectedItemKey) ? selectedItemKey : defaultLane(bodyProgress)?.key)
    : undefined
  const selectedStep: DeliveryStep | undefined = bodyProgress && selectedDef
    ? (localSteps.find((s) => s.id === `${selectedDef.id}::${activeItemKey}`)
      ?? { id: `${selectedDef.id}::${activeItemKey}`, nodeId: selectedDef.id, itemKey: activeItemKey, name: selectedDef.label ?? selectedDef.id, nodeName: selectedDef.label ?? selectedDef.id, status: 'Pending' as DeliveryStep['status'] })
    : localSteps.find((s) => s.id === selectedNodeId)
  const selectedForEachProgress = selectedDef?.type === 'forEach' ? (progresses.find((p) => p.nodeId === selectedDef.id) as UIProgress | undefined) : undefined
  const itemPanelProgress = itemSel ? (progresses.find((p) => p.nodeId === itemSel.feId) as UIProgress | undefined) : undefined
  const sidePanelOpen = !!(selectedStep && selectedNode) || !!(itemSel && itemPanelProgress) || !!selectedForEachProgress
  const selectedNodeTimeoutSeconds = selectedDef?.timeoutSeconds
  const isSelectedNodeActiveGate = selectedNodeId === delivery?.currentNodeId && delivery?.status === 'Paused'

  // Gate cards describe the *previous* step's output, not the gate block's own (the
  // human-gate native block always returns a static "Awaiting human review" summary).
  // Assumes a single incoming edge to the gate node — correct for the current
  // linear-only pipeline MVP; revisit if branching into a gate is ever supported.
  const previousStep = useMemo(() => {
    if (!selectedNode) return undefined
    const incoming = flowEdges.find((e) => e.target === selectedNode.id)
    if (!incoming) return undefined
    return localSteps.find((s) => s.id === incoming.source)
  }, [selectedNode, flowEdges, localSteps])

  const onNodeClick = useCallback((_e: React.MouseEvent, node: Node) => {
    setSelectedNodeId(node.id)
    setSelectedItemKey(null)
    setGateComment('')
  }, [])

  // Timeline entry -> select that node and ForEach item (item events open the item panel).
  const selectTimelineTarget = (t: NonNullable<TimelineEvent['target']>) => {
    setGateComment('')
    if (t.item && t.itemKey) { setSelectedNodeId(`item:${t.nodeId}::${t.itemKey}`); return }
    setSelectedNodeId(t.nodeId)
    setSelectedItemKey(t.itemKey ?? null)
  }

  const onPaneClick = useCallback(() => { setSelectedNodeId(null); setSelectedItemKey(null) }, [])

  // Loads the full context / output for one step. The main process reads the DS1 file
  // (under {userData}/runs/) when the delivery document only holds a truncated marker.
  const viewFullField = useCallback(async (
    kind: 'context' | 'output',
    step: DeliveryStep,
    title: string,
  ) => {
    if (!id) return
    // The context snapshot is only persisted when storeFullContext was on for this delivery.
    if (kind === 'context' && !delivery?.storeFullContext) {
      toast.info("Full context wasn't stored for this delivery — enable \"Store full context\" on a new delivery to capture it.")
      return
    }
    setViewerLoading(true)
    try {
      const data = kind === 'context' ? await getStepContext(id, step.id) : await getStepOutput(id, step.id)
      setViewerData({ title, data })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast.error(`Could not load full ${kind} (${message})`)
    } finally {
      setViewerLoading(false)
    }
  }, [id, delivery?.storeFullContext])

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
      warnIfClaudeKeyMissing()
      window.axon.delivery.start(id).then((startRes) => {
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

  // Periodic sync: refetch every 5s while Running. Deliberately excludes
  // Paused — that state can last indefinitely (waiting on a human decision),
  // nothing changes server-side until that happens, and live IPC progress
  // events already cover the cases that do (gate resolution, etc.). Polling
  // through an open-ended wait was pure unnecessary churn for no benefit.
  useEffect(() => {
    if (!id || !delivery || !delivery.status) return
    if (delivery.status !== 'Running') return

    const interval = setInterval(() => {
      refetch()
    }, 5000)

    return () => clearInterval(interval)
  }, [id, delivery, delivery?.status, refetch])

  // Subscribe to the single typed delivery event channel (D2).
  useEffect(() => {
    return window.axon.events.onDeliveryEvent((data: DeliveryEvent) => {
      if (data.deliveryId !== id) return
      switch (data.type) {
        case 'workspace_provisioning':
          addTimelineEvent('WorkspaceProvisioning', 'Workspace provisioning…')
          break
        case 'workspace_provisioned':
          addTimelineEvent('WorkspaceProvisioned', `Workspace provisioned — ${data.workspacePath}`)
          setLocalWorkspacePath(data.workspacePath)
          break
        case 'git_preparing':
          addTimelineEvent('GitPreparing', `Preparing codebase…${data.repoUrl ? ` ${data.repoUrl}` : ''}`)
          break
        case 'git_prepared':
          addTimelineEvent('GitPrepared', `Codebase prepared${data.branch ? ` — branch ${data.branch}` : ''}`)
          if (data.branch) setLocalBranch(data.branch)
          break
        case 'status_changed':
          setLocalStatus(data.status)
          break
        case 'step_started':
          if (data.itemKey) {
            // Lanes are rebuilt from the refetched delivery; only the signal feed is updated here.
            addTimelineEvent('StepStarted', `${data.blockName} [${data.itemKey}] started`, { nodeId: data.nodeId, itemKey: data.itemKey })
            break
          }
          setLocalSteps((prev) =>
            prev.map((s) =>
              s.id === data.nodeId
                ? { ...s, status: 'Running' as DeliveryStep['status'], startedAt: data.at }
                : s,
            ),
          )
          addTimelineEvent('StepStarted', `${data.blockName} started`, { nodeId: data.nodeId })
          break
        case 'step_completed':
          if (data.itemKey) {
            // Lanes are rebuilt from the refetched delivery; only the signal feed is updated here.
            addTimelineEvent('StepCompleted', `${data.blockName} [${data.itemKey}] completed`, { nodeId: data.nodeId, itemKey: data.itemKey })
            break
          }
          setLocalSteps((prev) =>
            prev.map((s) =>
              s.id === data.nodeId
                ? {
                    ...s,
                    status: 'Completed' as DeliveryStep['status'],
                    completedAt: data.at,
                    agentOutput: {
                      ...s.agentOutput,
                      summary: data.output.summary,
                      confidence: data.output.confidence,
                      toolsUsed: data.output.toolsUsed,
                      toolsDenied: data.output.toolsDenied,
                    },
                  }
                : s,
            ),
          )
          addTimelineEvent('StepCompleted', `${data.blockName} completed`, { nodeId: data.nodeId })
          break
        case 'step_failed':
          if (data.itemKey) {
            // Lanes are rebuilt from the refetched delivery; only the signal feed is updated here.
            addTimelineEvent('StepFailed', `${data.blockName} [${data.itemKey}] failed — ${data.message}`, { nodeId: data.nodeId, itemKey: data.itemKey })
            break
          }
          setLocalSteps((prev) =>
            prev.map((s) =>
              s.id === data.nodeId
                ? {
                    ...s,
                    status: 'Failed' as DeliveryStep['status'],
                    completedAt: data.at,
                    errorMessage: data.message,
                    agentOutput: {
                      ...s.agentOutput,
                      summary: data.output?.summary,
                      toolsUsed: data.output?.toolsUsed,
                      toolsDenied: data.output?.toolsDenied,
                      timedOut: data.output?.timedOut,
                    },
                  }
                : s,
            ),
          )
          addTimelineEvent('StepFailed', `${data.blockName} failed — ${data.message}`, { nodeId: data.nodeId })
          break
        case 'item_started':
          addTimelineEvent('StepStarted', `Item ${data.index + 1} of ${data.total} started — ${data.itemKey}`, { nodeId: data.nodeId, itemKey: data.itemKey, item: true })
          break
        case 'item_completed':
          addTimelineEvent('StepCompleted', `Item ${data.index + 1} of ${data.total} completed — ${data.itemKey}`, { nodeId: data.nodeId, itemKey: data.itemKey, item: true })
          break
        case 'item_failed':
          addTimelineEvent('StepFailed', `Item ${data.itemKey} failed — ${data.message}`, { nodeId: data.nodeId, itemKey: data.itemKey, item: true })
          break
        case 'gate_reached':
          setLocalSteps((prev) =>
            prev.map((s) =>
              s.id === data.nodeId
                ? {
                    ...s,
                    status: 'AwaitingApproval' as DeliveryStep['status'],
                    agentOutput: { ...s.agentOutput, humanGateReason: data.output.summary },
                  }
                : s,
            ),
          )
          addTimelineEvent('GateReached', `Awaiting approval — ${data.blockName}`, { nodeId: data.nodeId })
          break
        case 'gate_approved':
          setLocalSteps((prev) =>
            prev.map((s) => (s.id === data.nodeId ? { ...s, status: 'Completed' as DeliveryStep['status'] } : s)),
          )
          addTimelineEvent('GateApproved', `Gate approved by ${data.approvedBy}${data.comment ? ` — ${data.comment}` : ''}`)
          break
        case 'gate_rejected':
          setLocalSteps((prev) =>
            prev.map((s) => (s.id === data.nodeId ? { ...s, status: 'Failed' as DeliveryStep['status'] } : s)),
          )
          addTimelineEvent('GateRejected', `Gate rejected by ${data.rejectedBy} — ${data.comment}`)
          break
        case 'completed':
          addTimelineEvent('DeliveryCompleted', 'Delivery completed')
          if (data.prUrl) {
            setPrUrl(data.prUrl)
            addTimelineEvent('DeliveryCompleted', `PR Created: ${data.prUrl}`)
          }
          break
        case 'failed':
          addTimelineEvent('DeliveryFailed', `Delivery failed — ${data.message}`)
          break
        case 'cancelled':
          addTimelineEvent('DeliveryInterrupted', 'Delivery cancelled')
          break
        case 'interrupted':
          addTimelineEvent('DeliveryInterrupted', 'Delivery interrupted — resume to continue')
          break
      }
    })
  }, [id])



  // The main process records approver/timestamp/comment and resumes (approve) or fails the
  // delivery (reject) — status updates arrive through the delivery event channel.
  const handleApprove = async (comment: string) => {
    if (!id) return
    try {
      await approveGate.mutateAsync(comment || undefined)
      setGateComment('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to approve gate')
    }
  }

  const handleReject = async (comment: string) => {
    if (!id) return
    if (!comment.trim()) return
    try {
      await rejectGate.mutateAsync(comment)
      setGateComment('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to reject gate')
    }
  }

  const warnIfClaudeKeyMissing = useCallback(async () => {
    const usesClaude = (delivery?.pipelineSnapshot?.nodes ?? []).some(
      (n) => blockMap.get(n.blockId)?.agentRuntime === 'Claude'
    )
    if (!usesClaude) return
    const status = await window.axon.claudeKey.getStatus().catch(() => null)
    if (status && !status.hasKey) {
      toast.warning('No Claude API key resolved — this pipeline has Claude-runtime steps that will fail until one is set in Settings.')
    }
  }, [delivery, blockMap])

  const handleStart = async () => {
    if (!id) return
    autoStartedRef.current = true
    setIsStarting(true)
    setLocalStatus('Running')
    await warnIfClaudeKeyMissing()
    try {
      const res = await window.axon.delivery.start(id)
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
      const res = await window.axon.delivery.cancel(id)
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

  // Continues THIS delivery from wherever it actually stopped (resumeDelivery derives
  // the real resume point from which steps have a Completed record — not from
  // currentNodeId, which only reflects the last gate/failure, not ordinary progress).
  // Distinct from Retry, which creates a brand new delivery and re-runs everything from
  // the start — this resumes in place, skipping already-completed steps. Previews the
  // resolved resume point and reconstructed context first and asks for confirmation,
  // rather than just doing it — so the user isn't guessing what "Resume" will actually do.
  const handleResume = async () => {
    if (!id) return
    let previewMessage: string
    try {
      const previewRes = await window.axon.delivery.previewResume(id)
      if (!previewRes.success || !previewRes.preview) {
        toast.error(previewRes.error ? `Could not preview resume: ${previewRes.error}` : 'Could not preview resume')
        return
      }
      const p = previewRes.preview
      if (p.allNodesCompleted) {
        previewMessage = 'Every step already has a completed record — resuming will just mark this delivery Completed, nothing will run.'
      } else {
        const lines = [
          p.lastCompletedNodeLabel
            ? `Resuming after "${p.lastCompletedNodeLabel}", starting at "${p.resumeNodeLabel}".`
            : `Resuming from the very first step: "${p.resumeNodeLabel}".`,
          p.reconstructedContextKeys.length > 0
            ? `Carrying forward context from prior steps: ${p.reconstructedContextKeys.join(', ')}.`
            : `No prior step output to carry forward.`,
        ]
        // hasPriorAttempt means THIS exact node was already started once and didn't
        // finish cleanly (it has a step record, just never one marked Completed) — if it
        // can touch files (Execution/Agentic with Write/Edit/Bash), it may have left
        // partial, uncommitted changes in the workspace already. AXON has no snapshot to
        // roll back to; resuming just runs the node again on top of whatever's there now.
        // Steps that already completed cleanly need no such warning — their changes are
        // final and intentional, not partial.
        if (p.hasPriorAttempt) {
          lines.push(
            `\n⚠ "${p.resumeNodeLabel}" was already attempted once and didn't finish cleanly — it may have left partial, uncommitted changes in the workspace${p.workspacePath ? ` (${p.workspacePath})` : ''}${p.branch ? ` on branch ${p.branch}` : ''}. AXON does not roll those back; resuming runs this step again on top of whatever's already there. Review the workspace first if you're unsure.`,
          )
        }
        previewMessage = lines.join('\n')
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast.error(`Could not preview resume: ${message}`)
      return
    }

    if (!window.confirm(`Resume this delivery?\n\n${previewMessage}`)) return

    setIsStarting(true)
    setLocalStatus('Running')
    try {
      const res = await window.axon.delivery.resume(id)
      if (!res.success) {
        setLocalStatus(null)
        toast.error(res.error ? `Failed to resume delivery: ${res.error}` : 'Failed to resume delivery')
        return
      }
      queryClient.invalidateQueries({ queryKey: ['delivery', id] })
    } catch (err) {
      setLocalStatus(null)
      const message = err instanceof Error ? err.message : String(err)
      toast.error(`Failed to resume delivery: ${message}`)
    } finally {
      setIsStarting(false)
    }
  }

  // Rerun = a NEW delivery (first step again) linked to this one, which becomes Superseded. Resume continues this one.
  // "Run again" of a Completed delivery is a plain new run: nothing is superseded.
  const handleRetry = async (reason?: RerunReason) => {
    if (!delivery) return
    if (delivery.status === 'Completed' && !window.confirm('Run this delivery again as a new run?')) return
    try {
      const newDelivery = await createDelivery.mutateAsync({
        ticketId: delivery.ticketId,
        title: delivery.title,
        pipelineId: delivery.pipelineId,
        repoUrl: delivery.repoUrl,
        workspaceType: delivery.workspaceType,
        retriedFromDeliveryId: delivery.id,
        ...(reason ? { rerunReason: reason } : {}),
        inputs: delivery.inputs,
        workspacePath: delivery.workspacePath ?? undefined,
      })
      setRerunOpen(false)
      navigate(`/deliveries/${newDelivery.id}`)
    } catch {
      toast.error('Failed to rerun delivery')
    }
  }

  // Size of the delivery's workspace (worktrees); refreshed when the run settles or the workspace is removed.
  useEffect(() => {
    if (!id || !delivery?.workspacePath || delivery.status === 'Running') return
    window.axon.delivery.workspaceSize(id).then((r) => setWorkspaceBytes(r.success ? r.bytes : null)).catch(() => setWorkspaceBytes(null))
  }, [id, delivery?.workspacePath, delivery?.status, isClearingWorkspace])

  const handleClearWorkspace = async () => {
    const wsPath = deliveryFolderPath
    if (!wsPath || !delivery) return
    if (displayStatus === 'Running' || displayStatus === 'Paused') {
      toast.error('Stop the delivery before clearing its workspace')
      return
    }
    if (!window.confirm(
      `Remove this delivery workspace?\n\n${wsPath}\n\nThis removes its git worktrees and any uncommitted changes (pushed branches are unaffected; shared mirrors are kept). This cannot be undone.`,
    )) return
    setIsClearingWorkspace(true)
    try {
      const res = await window.axon.delivery.clearWorkspace(delivery.id)
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

  const handleOpenWorkspace = async () => {
    const wsPath = deliveryFolderPath
    if (!wsPath) return
    const res = await window.axon.shell.openPath(wsPath)
    if (!res.success) toast.error(res.error ? `Failed to open folder: ${res.error}` : 'Failed to open folder')
  }

  const addTimelineEvent = (type: TimelineEvent['type'], body: string, target?: TimelineEvent['target']) => {
    setTimeline((prev) => [{ type, body, timestamp: new Date().toISOString(), target }, ...prev].slice(0, 60))
  }

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
  // A Failed delivery can continue from its failed step unless it failed by a rejected approval (that needs a Rerun).
  const canResumeFailed = delivery.status === 'Failed'
    && localSteps.some((s) => s.status === 'Failed')
    && !localSteps.some((s) => s.agentOutput?.rejectedBy != null)
  const completedCount = localSteps.filter((s) => s.status === 'Completed').length
  const pipelineName = delivery.pipelineSnapshot?.name ?? delivery.pipelineName
  const createdBy = delivery.createdByName ?? 'Unknown'
  // The Delivery Folder (D17): Explorer / VS Code / Remove workspace all act on it, never on a repo.
  const effectiveWorkspacePath = deliveryFolderPath

  return (
    <div style={{ padding: 22, height: '100vh', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Topbar */}
      <div style={{
        height: 50, background: 'var(--axon-bg2)', borderBottom: '1px solid var(--axon-border)',
        margin: '-22px -22px 22px', display: 'flex', alignItems: 'center', padding: '0 22px', gap: 14, flexShrink: 0,
      }}>
        <Button variant="outline" size="sm" className="h-8" onClick={() => navigate('/deliveries')}>← Deliveries</Button>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--axon-t1)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {delivery.ticketId}
          {delivery.title && delivery.title !== delivery.ticketId ? ` — ${delivery.title}` : ''}
        </div>
        <Badge variant="outline" className="h-8 gap-1.5 rounded-md px-3 text-xs font-semibold" style={statusBadgeStyle(displayStatus)}>
          <span className="size-1.5 shrink-0 rounded-full bg-current" style={{ animation: displayStatus === 'Running' ? 'axon-node-pulse 1.6s infinite' : undefined }} />
          {displayStatus}
        </Badge>

        {displayStatus === 'Pending' && (
          <Button size="sm" className="h-8" onClick={handleStart} disabled={isStarting}>{isStarting ? 'Starting…' : '▶ Start'}</Button>
        )}
        {displayStatus === 'Running' && (
          <Button size="sm" variant="destructive" className="h-8" onClick={handleStop} disabled={isStopping}>{isStopping ? 'Stopping…' : '■ Stop'}</Button>
        )}
        {(displayStatus === 'Cancelled' || displayStatus === 'Interrupted' || (displayStatus === 'Failed' && canResumeFailed)) && (
          <Button
            size="sm" className="h-8" onClick={handleResume} disabled={isStarting}
            title="Continue this same delivery from the failed or stopped step in the same workspace (that step's folder is restored first), skipping completed steps"
          >
            {isStarting ? 'Resuming…' : '▶ Resume'}
          </Button>
        )}
        {(displayStatus === 'Failed' || displayStatus === 'Cancelled') && (
          <Button size="sm" variant="outline" className="h-8" onClick={() => setRerunOpen(true)} disabled={createDelivery.isPending}
            title="Start a new delivery from the first step; this one is marked Superseded">
            ↻ Rerun
          </Button>
        )}
        {displayStatus === 'Completed' && (
          <Button size="sm" variant="outline" className="h-8" onClick={() => handleRetry()} disabled={createDelivery.isPending}>
            {createDelivery.isPending ? 'Starting…' : '↻ Run again'}
          </Button>
        )}
        <RerunDialog
          open={rerunOpen}
          ticketId={delivery.ticketId}
          busy={createDelivery.isPending}
          onCancel={() => setRerunOpen(false)}
          onConfirm={(reason) => handleRetry(reason)}
        />
      </div>

      {/* RRA Banner — only when pipeline includes an RRA step */}
      {localSteps.some((s) => s.name.includes('RRA') || s.nodeName?.includes('RRA')) && (
        <RraBanner steps={localSteps} />
      )}

      {/* Main grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16, flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {/* Left: pipeline graph */}
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10, flexShrink: 0, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--axon-t1)' }}>
              Pipeline Execution
            </div>
          </div>
          <div style={{
            flex: 1, minHeight: 0, background: '#0f1117', border: '1px solid var(--axon-border)',
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
                onInit={(instance) => { reactFlowInstanceRef.current = instance }}
                fitView
                fitViewOptions={{ maxZoom: 0.85, padding: 0.25 }}
                proOptions={{ hideAttribution: true }}
                style={{ background: '#0f1117' }}
              >
                <Background color="#1e293b" gap={20} />
                <Controls showInteractive={false} />
                <Panel position="top-left">
                  <div className="pointer-events-none flex items-center gap-3 rounded-md border bg-card/80 px-2.5 py-1.5 text-[10px] text-muted-foreground backdrop-blur-sm">
                    {([
                      ['Pending', '#64748b'], ['Running', '#3b82f6'], ['Success', '#22c55e'],
                      ['Awaiting approval', '#f59e0b'], ['Failed', '#ef4444'],
                    ] as const).map(([label, color]) => (
                      <span key={label} className="inline-flex items-center gap-1.5">
                        <span className="size-2 rounded-full" style={{ background: color }} />
                        {label}
                      </span>
                    ))}
                  </div>
                </Panel>
              </ReactFlow>
            </ReactFlowProvider>
          </div>
        </div>

        {/* Right: node detail (when selected) or Signals + Job details */}
        <div style={{ minWidth: 0, overflowY: 'auto' }}>
          {itemSel && itemPanelProgress && (
            <ItemPanel
              progress={itemPanelProgress}
              itemKey={itemSel.key}
              repos={repoInfo?.repos ?? []}
              onClose={() => setSelectedNodeId(null)}
              onSelectStep={(st) => { setSelectedNodeId(st.nodeId); setSelectedItemKey(st.itemKey ?? null) }}
              onView={(kind, st) => viewFullField(kind, st, `${kind === 'context' ? 'Input' : 'Output'} — ${st.nodeName ?? st.name} [${st.itemKey}]`)}
            />
          )}
          {selectedForEachProgress && (
            <ForEachTable
              progress={selectedForEachProgress}
              onClose={() => setSelectedNodeId(null)}
              onSelectItem={(key) => setSelectedNodeId(`item:${selectedForEachProgress.nodeId}::${key}`)}
              onViewOutput={(st) => viewFullField('output', st, `Output — ${st.nodeName ?? st.name} [${st.itemKey}]`)}
            />
          )}
          {selectedStep && selectedNode && !selectedForEachProgress ? (
            <div style={{
              background: 'var(--axon-bg2)', border: '1px solid var(--axon-border)',
              borderRadius: 12, padding: '16px', marginBottom: 16,
              boxShadow: '0 4px 24px rgba(0,0,0,0.18)',
            }}>
              {bodyProgress && <ItemSwitcher progress={bodyProgress} activeKey={activeItemKey} onSelect={setSelectedItemKey} />}

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
                      {selectedStep.nodeName ?? selectedStep.name}{selectedStep.itemKey ? ` · ${selectedStep.itemKey}` : ''}
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
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setSelectedNodeId(null)}
                  style={{ color: 'var(--axon-t3)', flexShrink: 0 }}
                >
                  ✕
                </Button>
              </div>

              {/* Status + timings */}
              <div className="mb-3 flex items-center gap-3">
                <span style={{
                  ...statusBadgeStyle(selectedStep.status === 'AwaitingApproval' ? 'Paused' : selectedStep.status === 'Completed' ? 'Completed' : selectedStep.status),
                  fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 6,
                }}>
                  {selectedStep.status === 'AwaitingApproval' ? 'Awaiting approval' : selectedStep.status}
                </span>
                {selectedStep.startedAt && !selectedStep.completedAt && selectedStep.status === 'Running' && (
                  <span className="text-xs text-muted-foreground">running for <b className="text-foreground">{formatTotalDuration(selectedStep.startedAt)}</b></span>
                )}
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2 rounded-md border bg-muted/30 px-3 py-2">
                {([
                  ['Started', selectedStep.startedAt ? new Date(selectedStep.startedAt).toLocaleTimeString() : '—'],
                  ['Ended', selectedStep.completedAt ? new Date(selectedStep.completedAt).toLocaleTimeString() : '—'],
                  ['Took', selectedStep.startedAt && selectedStep.completedAt ? formatTotalDuration(selectedStep.startedAt, selectedStep.completedAt) : '—'],
                ] as const).map(([k, v]) => (
                  <div key={k} className="flex min-w-0 flex-col">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{k}</span>
                    <span className="truncate text-xs font-semibold text-foreground">{v}</span>
                  </div>
                ))}
              </div>
              <Tabs value={panelTab} onValueChange={(v) => setPanelTab(v as typeof panelTab)} className="mb-3">
                <TabsList className="w-full">
                  <TabsTrigger value="overview">Overview</TabsTrigger>
                  <TabsTrigger value="input">Input</TabsTrigger>
                  <TabsTrigger value="output">Output</TabsTrigger>
                </TabsList>
              </Tabs>
              <Separator className="mb-3" />

              {panelTab === 'overview' && (<>
              {/* Summary — quick TL;DR, shown prominently up top */}
              {selectedStep.agentOutput?.summary && !(selectedStep.status === 'Failed' && selectedStep.agentOutput.summary === selectedStep.errorMessage) && (
                <div style={{
                  borderLeft: '2px solid var(--axon-nexus2)', paddingLeft: 10,
                  fontSize: 11.5, color: 'var(--axon-t2)', lineHeight: 1.5, marginBottom: 14, fontStyle: 'italic', overflowWrap: 'anywhere',
                }}>
                  “{selectedStep.agentOutput.summary}”
                </div>
              )}

              {selectedStep.status === 'AwaitingApproval' && (
                <div style={{
                  background: 'var(--axon-amber-d)', border: '1px solid rgba(245,158,11,0.3)',
                  borderRadius: 8, padding: 11, marginBottom: 14,
                }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--axon-amber)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    ⚠ Review {previousStep?.nodeName ? `— ${previousStep.nodeName}` : ''}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--axon-t2)', lineHeight: 1.5, marginBottom: isSelectedNodeActiveGate ? 10 : 0 }}>
                    {previousStep?.agentOutput?.summary ||
                      "This step didn't provide a summary. Review its full output below."}
                  </div>
                  {isSelectedNodeActiveGate && (
                    <>
                      <textarea
                        value={gateComment}
                        onChange={(e) => setGateComment(e.target.value)}
                        placeholder="Optional comment (required to reject)"
                        rows={2}
                        style={{
                          width: '100%', boxSizing: 'border-box', resize: 'vertical', marginBottom: 8,
                          background: 'var(--axon-bg3)', border: '1px solid var(--axon-border2)', borderRadius: 6,
                          color: 'var(--axon-t1)', fontSize: 11, fontFamily: 'inherit', padding: '6px 8px',
                        }}
                      />
                      <div style={{ display: 'flex', gap: 7 }}>
                        <Button
                          size="sm"
                          onClick={() => handleApprove(gateComment)}
                          className="border border-emerald-600/25 bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20"
                        >
                          ✓ Approve &amp; Continue
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => handleReject(gateComment)}
                          disabled={!gateComment.trim()}
                          title={!gateComment.trim() ? 'A comment is required to reject' : undefined}
                        >
                          ✕ Reject Delivery
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              )}

              {selectedStep.status === 'Completed' && selectedBlock?.role === 'Control' && selectedStep.agentOutput?.approvedBy != null && (
                <div style={{
                  background: 'var(--axon-green-d)', border: '1px solid rgba(16,185,129,0.3)',
                  borderRadius: 8, padding: 11, marginBottom: 14, fontSize: 11, color: 'var(--axon-t2)',
                }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--axon-green)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    ✓ Approved
                  </div>
                  <div>
                    by <b style={{ color: 'var(--axon-t1)' }}>{selectedStep.agentOutput.approvedBy}</b>
                    {selectedStep.agentOutput.approvedAt != null && (
                      <> on <b style={{ color: 'var(--axon-t1)' }}>{new Date(selectedStep.agentOutput.approvedAt).toLocaleString()}</b></>
                    )}
                  </div>
                  {selectedStep.agentOutput.reviewComment != null && (
                    <div style={{ marginTop: 6, fontStyle: 'italic', color: 'var(--axon-t2)' }}>
                      “{selectedStep.agentOutput.reviewComment}”
                    </div>
                  )}
                </div>
              )}

              {selectedStep.status === 'Failed' && (
                <div style={{
                  background: 'var(--axon-red-d)', border: '1px solid rgba(239,68,68,0.3)',
                  borderRadius: 8, padding: 11, marginBottom: 14,
                }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--axon-red)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.04em', display: 'flex', alignItems: 'center', gap: 6 }}>
                    {selectedStep.agentOutput?.timedOut ? '⏱ Timed Out' : '✕ Error'}
                  </div>
                  {selectedStep.agentOutput?.timedOut && (
                    <div style={{ fontSize: 10.5, color: 'var(--axon-t2)', marginBottom: 6 }}>
                      This block didn't finish within its configured timeout
                      {selectedNodeTimeoutSeconds != null && (
                        <> (<b style={{ color: 'var(--axon-t1)' }}>{selectedNodeTimeoutSeconds}</b>s)</>
                      )}.
                    </div>
                  )}
                  <div style={{ fontSize: 11, color: 'var(--axon-t2)', lineHeight: 1.5, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
                    {selectedStep.errorMessage ?? 'An error occurred during this step.'}
                  </div>
                  {selectedBlock && selectedBlock.agentRuntime !== 'Axon' && selectedStep.cwd && delivery?.status === 'Failed' && (
                    <div data-testid="failed-attempt-note" style={{ marginTop: 8, fontSize: 10.5, color: 'var(--axon-t2)', paddingTop: 8, borderTop: '1px solid rgba(239,68,68,0.2)' }}>
                      Changes from the failed attempt are still in the folder; Resume restores the pre-step state.
                    </div>
                  )}
                  {selectedBlock?.role === 'Control' && selectedStep.agentOutput?.rejectedBy != null && (
                    <div style={{ marginTop: 8, fontSize: 10.5, color: 'var(--axon-t2)', paddingTop: 8, borderTop: '1px solid rgba(239,68,68,0.2)' }}>
                      Rejected by <b style={{ color: 'var(--axon-t1)' }}>{selectedStep.agentOutput.rejectedBy}</b>
                      {selectedStep.agentOutput.rejectedAt != null && (
                        <> on <b style={{ color: 'var(--axon-t1)' }}>{new Date(selectedStep.agentOutput.rejectedAt).toLocaleString()}</b></>
                      )}
                    </div>
                  )}
                </div>
              )}

              </>)}
              {panelTab === 'input' && (<>
              {/* Configured Context Fields — what this block declares it needs, colored by availability */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 7 }}>
                <span style={{ color: 'var(--axon-nexus2)', fontSize: 11 }}>↓</span>
                <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--axon-t3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Configured Context Fields
                </span>
              </div>
              <div style={{ marginBottom: 14 }}>
                <FieldAvailabilityChips
                  declaredFields={selectedBlock?.contextRequirements}
                  availability={selectedStep.contextAvailability}
                  emptyLabel="(no context fields required)"
                />
                {selectedStep.catalogStats && (
                  <div data-testid="catalog-stats" style={{ fontSize: 11, color: '#94a3b8', marginTop: 6 }}>
                    repoCatalog: {selectedStep.catalogStats.repos} repo{selectedStep.catalogStats.repos === 1 ? '' : 's'}, ~{selectedStep.catalogStats.approxTokens} tokens
                  </div>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                className="mb-3.5 w-full"
                disabled={viewerLoading}
                onClick={() => viewFullField('context', selectedStep, `Input — ${selectedStep.nodeName ?? selectedStep.name}`)}
              >
                View full context snapshot
              </Button>

              </>)}
              {panelTab === 'output' && (<>
              {/* Configured Output Fields — what this block declares it produces, colored by availability */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 7 }}>
                <span style={{ color: 'var(--axon-green)', fontSize: 11 }}>↑</span>
                <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--axon-t3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Configured Output Fields
                </span>
              </div>
              <div style={{ marginBottom: 14 }}>
                <FieldAvailabilityChips
                  declaredFields={selectedBlock?.outputSchema}
                  availability={selectedStep.outputAvailability}
                  emptyLabel="(no output schema declared)"
                  verb="returned"
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                className="mb-3.5 w-full"
                disabled={viewerLoading}
                onClick={() => viewFullField('output', selectedStep, `Output — ${selectedStep.nodeName ?? selectedStep.name}`)}
              >
                View full output
              </Button>

              </>)}
              {panelTab === 'overview' && (<>
              {/* Tools Used / Denied — only meaningful for Agentic-mode blocks; absent
                  entirely (both undefined) for Prompt-mode blocks, so this section just
                  doesn't render rather than showing an empty "none" state for every
                  Prompt block in every delivery. */}
              {((selectedStep.agentOutput?.toolsUsed?.length ?? 0) > 0 || (selectedStep.agentOutput?.toolsDenied?.length ?? 0) > 0) && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--axon-t3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 7 }}>
                    Tools
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                    {selectedStep.agentOutput?.toolsUsed?.map((tool) => (
                      <Badge key={`used-${tool}`} variant="outline" className="border-emerald-600/30 bg-emerald-500/10 text-emerald-500" title="Used">
                        ✓ {tool}
                      </Badge>
                    ))}
                    {selectedStep.agentOutput?.toolsDenied?.map((tool) => (
                      <Badge key={`denied-${tool}`} variant="outline" className="border-red-600/30 bg-red-500/10 text-red-500" title="Attempted, blocked">
                        ✕ {tool}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {/* D5: confidence is optional and display-only: no threshold, nothing for native Axon blocks or when absent. */}
              {showConfidence(selectedStep.agentOutput?.confidence, selectedBlock?.agentRuntime) && (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--axon-t3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      Confidence
                    </span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--axon-t2)' }}>
                      {Math.round((selectedStep.agentOutput?.confidence ?? 0) * 100)}%
                    </span>
                  </div>
                  <div style={{ height: 6, background: 'var(--axon-bg3)', borderRadius: 4, overflow: 'hidden' }}>
                    <div style={{
                      height: '100%', width: `${Math.round((selectedStep.agentOutput?.confidence ?? 0) * 100)}%`,
                      background: 'var(--axon-nexus2)', borderRadius: 4, transition: 'width 0.3s ease',
                    }} />
                  </div>
                </div>
              )}
              </>)}
            </div>
          ) : null}

          <div style={{ display: sidePanelOpen ? 'none' : 'block' }}>
          {/* Job Details */}
          <div className="mb-2 text-xs font-semibold text-foreground">Job details</div>
          <Card className="mb-4 gap-0 py-2">
            <CardContent className="divide-y px-4">
              {[
                ...(delivery.localSeq ? [{ k: 'Run', v: `#${delivery.localSeq}` }] : []),
                { k: 'Pipeline', v: pipelineName },
                { k: 'Triggered by', v: createdBy },
                { k: 'Step', v: `${completedCount} of ${localSteps.length}` },
                ...(delivery.attemptNumber && delivery.attemptNumber > 1 ? [{ k: 'Attempt', v: `#${delivery.attemptNumber}` }] : []),
              ].map(({ k, v }) => (
                <div key={k} className="flex items-baseline justify-between gap-4 py-2 text-xs">
                  <span className="shrink-0 text-muted-foreground">{k}</span>
                  <span className="min-w-0 truncate text-right font-medium text-foreground" title={typeof v === 'string' ? v : undefined}>{v}</span>
                </div>
              ))}
              <div className="flex flex-col gap-1.5 py-2.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Delivery folder</span>
                  {deliveryFolderPath && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="outline" size="icon-sm" onClick={handleOpenWorkspace} aria-label="Open the delivery folder in Explorer"><FolderOpen /></Button>
                      </TooltipTrigger>
                      <TooltipContent>Open in Explorer</TooltipContent>
                    </Tooltip>
                  )}
                </div>
                <code className="break-all rounded bg-muted/40 px-2 py-1 font-mono text-[11px] leading-snug text-foreground">{deliveryFolderPath ?? '—'}</code>
              </div>
            </CardContent>
          </Card>

          {(repoInfo?.repos.length ?? 0) > 0 && (
            <>
              <div className="mb-2 text-xs font-semibold text-foreground">Repositories</div>
              <Card className="mb-4 gap-0 py-1">
                <CardContent className="divide-y px-4">
                  {repoInfo?.repos.map((r) => (
                    <div key={r.path} className="flex flex-col gap-2 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-sm font-semibold text-foreground" title={r.path}>{r.name}</span>
                        <div className="flex shrink-0 items-center gap-1">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button variant="outline" size="icon-sm" aria-label={`Open ${r.name} in Explorer`} onClick={async () => {
                                const res = await window.axon.shell.openPath(r.path)
                                if (!res.success) toast.error(res.error ? `Failed to open folder: ${res.error}` : 'Failed to open folder')
                              }}><FolderOpen /></Button>
                            </TooltipTrigger>
                            <TooltipContent>Open in Explorer</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button variant="outline" size="icon-sm" aria-label={`Open ${r.name} in VS Code`} onClick={async () => {
                                const res = await window.axon.shell.openInVSCode(r.path)
                                if (!res.success) toast.error(res.error ? `Failed to open VS Code: ${res.error}` : 'Failed to open VS Code')
                              }}><Code2 /></Button>
                            </TooltipTrigger>
                            <TooltipContent>Open in VS Code</TooltipContent>
                          </Tooltip>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="secondary" className="max-w-full font-mono text-[10.5px]" title={r.branch}><span className="truncate">{r.branch}</span></Badge>
                        {r.prUrl && (
                          <Button variant="outline" size="sm" className="h-6 px-2 text-[11px]" onClick={() => window.axon.shell.openExternal(r.prUrl as string)} title={r.prUrl}>
                            PR #{r.prUrl.split('/').pop()} ↗
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </>
          )}

          {delivery.workspaceNotice && (
            <div
              role="alert"
              style={{
                background: 'var(--axon-amber-d)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: 10,
                padding: '10px 12px', margin: '8px 0 12px', fontSize: 11, lineHeight: 1.5, color: 'var(--axon-amber)',
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 4 }}>
                {delivery.workspaceNotice.kind === 'stashed' ? 'Changes were stashed in your workspace folder' : 'Workspace folder was not restored'}
              </div>
              {delivery.workspaceNotice.message}
            </div>
          )}

          {delivery.supersededBy && (
            <button
              data-testid="superseded-link"
              onClick={() => navigate(`/deliveries/${delivery.supersededBy}`)}
              style={{ background: 'transparent', color: 'var(--axon-nexus2)', border: 'none', padding: '6px 0', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}
            >
              Superseded — view the newer attempt →
            </button>
          )}
          {delivery.retriedFromDeliveryId && (
            <button
              onClick={() => navigate(`/deliveries/${delivery.retriedFromDeliveryId}`)}
              style={{
                background: 'transparent', color: 'var(--axon-t3)',
                border: 'none', padding: '6px 0', fontSize: 10.5,
                cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
              }}
            >
              ← View previous attempt{delivery.attemptNumber && delivery.attemptNumber > 1 ? ` (this is attempt ${delivery.attemptNumber}${delivery.rerunReason ? `, reason: ${delivery.rerunReason}` : ''})` : ''}
            </button>
          )}

          {effectiveWorkspacePath && displayStatus !== 'Running' && displayStatus !== 'Paused' && (
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
              {isClearingWorkspace ? 'Removing…' : `🗑 Remove workspace${workspaceBytes !== null ? ` (${formatBytes(workspaceBytes)})` : ''}`}
            </button>
          )}

          {/* Completion Cards */}
          {displayStatus === 'Completed' && (
            <>
              {(delivery.prUrls?.length ? delivery.prUrls : prUrl ? [{ repo: prUrl.split('/').slice(-3, -2)[0] ?? 'PR', url: prUrl }] : []).map((pr) => (
                <div key={pr.url} style={{
                  background: 'var(--axon-green-d)', border: '1px solid rgba(16,185,129,0.2)',
                  borderRadius: 12, padding: '12px 14px', marginBottom: 16,
                }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--axon-green)', marginBottom: 8 }}>
                    ✓ PR Created — {pr.repo}
                  </div>
                  <button
                    onClick={async () => {
                      await window.axon.shell.openExternal(pr.url)
                    }}
                    style={{
                      background: 'transparent', color: 'var(--axon-green)',
                      border: '1px solid rgba(16,185,129,0.3)',
                      padding: '6px 10px', borderRadius: 6, fontSize: 11, fontWeight: 500,
                      cursor: 'pointer', fontFamily: 'inherit', width: '100%', textAlign: 'left',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}
                    title={pr.url}
                  >
                    {pr.url.split('/').slice(-2).join('/')} ↗
                  </button>
                </div>
              ))}
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

          {/* Timeline: newest first; click an entry to jump to that step (and ForEach item). */}
          <div className="mb-2 text-xs font-semibold text-foreground">Timeline</div>
          {timeline.length === 0 ? (
            <p className="rounded-md border bg-card px-3 py-2 text-xs text-muted-foreground">Waiting for events…</p>
          ) : (
            <div className="flex flex-col gap-1.5 pb-4">
              {timeline.map((sig, i) => (
                <div
                  key={i}
                  onClick={() => sig.target && selectTimelineTarget(sig.target)}
                  title={sig.target ? 'Show this step' : undefined}
                  className={`rounded-md border bg-card px-3 py-2 ${sig.target ? 'cursor-pointer hover:bg-accent/40' : ''}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: eventTypeColor[sig.type] }}>
                      <span className="size-1.5 rounded-full bg-current" />
                      {eventTypeLabel[sig.type]}
                    </span>
                    <span className="font-mono text-[10px] text-muted-foreground" title={timeAgo(sig.timestamp)}>{new Date(sig.timestamp).toLocaleTimeString()}</span>
                  </div>
                  <p className="mt-1 line-clamp-3 break-words text-xs text-foreground/90" title={sig.body}>{sig.body}</p>
                </div>
              ))}
            </div>
          )}
          </div>
        </div>
      </div>

      <RawDataViewerModal
        open={viewerData != null}
        onOpenChange={(open) => { if (!open) setViewerData(null) }}
        title={viewerData?.title ?? ''}
        data={viewerData?.data}
      />

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
