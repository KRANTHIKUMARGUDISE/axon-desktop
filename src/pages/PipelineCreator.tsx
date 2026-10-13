import '@xyflow/react/dist/style.css'
import { useState, useCallback, useMemo, useEffect } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Alert, AlertDescription } from '../components/ui/alert'
import { Button } from '../components/ui/button'
import { History } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap,
  useNodesState, useEdgesState, useReactFlow, addEdge, reconnectEdge,
  type Node, type Edge, type Connection, type NodeTypes, type EdgeTypes,
  type OnNodesDelete, type OnEdgesDelete,
} from '@xyflow/react'
import { toast } from 'sonner'
import { contextKey, isOptionalContext, readGateConfig, validatePipeline, toPipelineNodes, parentsFirst, canvasNodeSize, forEachSourceLabel, FOREACH_DEFAULT_SIZE } from '@shared'
import type { PipelineNode as SharedNode, PipelineEdge as SharedEdge, CanvasNode, OnFailureAction } from '@shared'
import PropertiesPanel from '../components/pipeline/PropertiesPanel'
import { useConfirm } from '../components/shared/ConfirmDialog'
import { getBlocks } from '../services/blocksService'
import { getPipeline, getPipelineVersion, createPipeline, updatePipeline } from '../services/pipelinesService'
import type { BlockType, PipelineNode, PipelineEdge, ValidationResult } from '../types'
import Palette from '../components/pipeline/Palette'
import DecisionNode from '../components/pipeline/nodes/DecisionNode'
import ExecutionNode from '../components/pipeline/nodes/ExecutionNode'
import KnowledgeNode from '../components/pipeline/nodes/KnowledgeNode'
import ControlNode from '../components/pipeline/nodes/ControlNode'
import IONode from '../components/pipeline/nodes/IONode'
import UtilityNode from '../components/pipeline/nodes/UtilityNode'
import ForEachNode from '../components/pipeline/nodes/ForEachNode'
import ConditionalEdge from '../components/pipeline/ConditionalEdge'

const nodeTypes: NodeTypes = {
  decisionNode: DecisionNode,
  executionNode: ExecutionNode,
  knowledgeNode: KnowledgeNode,
  controlNode: ControlNode,
  ionode: IONode,
  utilityNode: UtilityNode,
  forEachNode: ForEachNode,
}

const edgeTypes: EdgeTypes = {
  conditionalEdge: ConditionalEdge,
}

// Canvas <-> stored-node translation lives in shared/pipelineGraph.ts (unit-tested).
const sortParentsFirst = (nodes: Node[]): Node[] => parentsFirst(nodes)
const sizeOf = (n: Node) => canvasNodeSize(n as unknown as CanvasNode)
const toSharedNodes = (nodes: Node[]): SharedNode[] => toPipelineNodes(nodes as unknown as CanvasNode[])

function toSharedEdges(edges: Edge[]): SharedEdge[] {
  return edges.map(e => ({
    id: e.id, sourceNodeId: e.source, targetNodeId: e.target,
    isDefault: (e.data as any)?.isDefault ?? false,
    condition: (e.data as any)?.condition ? { expression: (e.data as any).condition, targetNodeId: e.target } : null,
  }))
}

function validate(nodes: Node[], edges: Edge[], blocks: any[]): ValidationResult {
  const byId = new Map(blocks.map(b => [b.id, {
    id: b.id, role: b.role, artifactName: b.artifactName, executionType: b.executionType,
    contextRequirements: b.contextRequirements, outputSchema: b.outputSchemaTyped ?? b.outputSchema,
    requiredItemFields: b.requiredItemFields,
  }]))
  const v = validatePipeline(toSharedNodes(nodes), toSharedEdges(edges), byId as any)
  const warnings = [...v.warnings]
  const incoming = new Set(edges.map(e => e.target))
  const outgoing = new Set(edges.map(e => e.source))
  const disconnected = nodes.filter(n => !n.parentId && !incoming.has(n.id) && !outgoing.has(n.id))
  if (nodes.length > 1 && disconnected.length) warnings.push(`${disconnected.length} disconnected node(s): ${disconnected.map(n => n.data?.label).join(', ')}`)
  return { valid: v.valid, errors: v.errors, warnings }
}

// Inner component so useReactFlow works (must be inside ReactFlowProvider)
interface NewNodeDrop {
  blockId?: string
  blockType?: BlockType
  blockName?: string
  blockRuntime?: string
  flowType?: 'forEach'
  position: { x: number; y: number }
}

interface FlowCanvasProps {
  nodes: Node[]
  edges: Edge[]
  onNodesChange: ReturnType<typeof useNodesState>[2]
  onEdgesChange: ReturnType<typeof useEdgesState>[2]
  onConnect: (c: Connection) => void
  onReconnect: (oldEdge: Edge, newConnection: Connection) => void
  isValidConnection: (c: Connection | Edge) => boolean
  onNodeClick: (e: React.MouseEvent, n: Node) => void
  onPaneClick: () => void
  onNewNode: (d: NewNodeDrop) => void
  onNodeDragStop: (e: unknown, n: Node, getAbs: (id: string) => { x: number; y: number } | undefined, intersecting: Node[]) => void
  onNodesDelete: OnNodesDelete
  onEdgesDelete: OnEdgesDelete
  onNodeContextMenu: (e: React.MouseEvent, n: Node) => void
  readOnly?: boolean
}

function FlowCanvas({
  nodes, edges, onNodesChange, onEdgesChange, onConnect, onReconnect,
  isValidConnection, onNodeClick, onPaneClick, onNewNode, onNodeDragStop, onNodesDelete, onEdgesDelete, onNodeContextMenu, readOnly,
}: FlowCanvasProps) {
  const { screenToFlowPosition, getIntersectingNodes, getInternalNode } = useReactFlow()

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const flowType = e.dataTransfer.getData('flowType')
    if (flowType === 'forEach') {
      onNewNode({ flowType: 'forEach', position: screenToFlowPosition({ x: e.clientX, y: e.clientY }) })
      return
    }
    const blockId = e.dataTransfer.getData('blockId')
    const blockType = e.dataTransfer.getData('blockType') as BlockType
    const blockName = e.dataTransfer.getData('blockName')
    const blockRuntime = e.dataTransfer.getData('blockRuntime')
    if (!blockId) return
    const position = screenToFlowPosition({ x: e.clientX, y: e.clientY })
    onNewNode({ blockId, blockType, blockName, blockRuntime, position })
  }, [screenToFlowPosition, onNewNode])

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onDrop={readOnly ? undefined : onDrop}
      nodesDraggable={!readOnly}
      nodesConnectable={!readOnly}
      edgesReconnectable={!readOnly}
      onDragOver={onDragOver}
      onNodeClick={onNodeClick}
      onNodeContextMenu={onNodeContextMenu}
      onNodeDragStop={(ev, n) => onNodeDragStop(
        ev, n,
        (id) => getInternalNode(id)?.internals.positionAbsolute,
        getIntersectingNodes(n).filter(x => x.type === 'forEachNode' && x.id !== n.id),
      )}
      onPaneClick={onPaneClick}
      onNodesDelete={onNodesDelete}
      onEdgesDelete={onEdgesDelete}
      onReconnect={onReconnect}
      isValidConnection={isValidConnection}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      deleteKeyCode={readOnly ? null : 'Delete'}
      fitView
      fitViewOptions={{ maxZoom: 0.85, padding: 0.25 }}
      proOptions={{ hideAttribution: true }}
      style={{ background: '#0f1117' }}
    >
      <Background color="#1e293b" gap={20} />
      <Controls />
      <MiniMap
        style={{ background: '#111827', border: '1px solid #1e293b' }}
        nodeColor="#334155"
        pannable
        zoomable
      />
    </ReactFlow>
  )
}

export default function PipelineCreator() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { id } = useParams<{ id: string }>()
  const isEditMode = Boolean(id)
  // ?version=N opens an older published version for looking only (the version a delivery ran, or a rule is pinned to).
  const [searchParams] = useSearchParams()
  const versionParam = Number(searchParams.get('version')) || null
  const [older, setOlder] = useState<{ viewing: number; latest: number } | null>(null)
  const readOnly = older !== null
  const [pipelineName, setPipelineName] = useState('Untitled Pipeline')
  const [pipelineDescription, setPipelineDescription] = useState('')
  // S5b: "On failure" actions (pipeline setting, pinned with the published version).
  const [onFailure, setOnFailure] = useState<OnFailureAction[]>([])
  const [onFailureOnCancel, setOnFailureOnCancel] = useState(false)
  const [blocks, setBlocks] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  // The latest document, or an older version of it (then the page is read-only and says so).
  async function loadPipelineDoc(pid: string, version: number | null) {
    const latest = await getPipeline(pid)
    if (version && version !== Number(latest.version)) {
      const doc = await getPipelineVersion(pid, version)
      setOlder({ viewing: version, latest: Number(latest.version) })
      return doc
    }
    setOlder(null)
    return latest
  }

  useEffect(() => {
    async function loadData() {
      setLoading(true)
      try {
        const [blocksData, pipelineData] = await Promise.all([
          getBlocks(),
          isEditMode && id ? loadPipelineDoc(id, versionParam) : Promise.resolve(null),
        ])
        setBlocks(blocksData)

        if (pipelineData) {
          setPipelineName(pipelineData.name)
          setPipelineDescription(pipelineData.description ?? '')
          setOnFailure(((pipelineData as any).onFailure ?? []) as OnFailureAction[])
          setOnFailureOnCancel((pipelineData as any).onFailureOnCancel === true)

          // Create a map of blockId -> block for quick lookup
          const blockMap = new Map<string, any>()
          blocksData.forEach(block => {
            blockMap.set(block.id, block)
          })

          const rfNodes = (pipelineData.nodes ?? []).map(n => {
            // Determine node type: from backend field, from block definition, or default to Execution
            let nodeType = (n as any).type || (n as any).nodeType
            if (nodeType === 'forEach') {
              return {
                id: n.id,
                type: 'forEachNode',
                position: n.position,
                style: { width: n.size?.width ?? FOREACH_DEFAULT_SIZE.width, height: n.size?.height ?? FOREACH_DEFAULT_SIZE.height },
                zIndex: -1,
                data: {
                  label: (n as any).label || (n as any).name || 'ForEach', nodeType: 'forEach',
                  maxItems: n.maxItems, onEmpty: n.onEmpty ?? 'fail',
                },
              } as Node
            }
            if (nodeType === 'block') nodeType = undefined
            // The block's current role wins over a type stored with an older pipeline version (e.g. a block that changed role).
            const currentRole = blockMap.get(n.blockId)?.role
            if (currentRole) nodeType = currentRole
            if (!nodeType && n.blockId) {
              nodeType = blockMap.get(n.blockId)?.role || blockMap.get(n.blockId)?.type || 'Execution'
            }
            nodeType = nodeType || 'Execution'

            const typeKey = typeof nodeType === 'string' ? nodeType.toLowerCase() : 'execution'
            const block = blockMap.get(n.blockId)
            return {
              id: n.id,
              type: typeKey === 'io' ? 'ionode' : `${typeKey}Node`,
              position: n.position,
              ...(n.parentId ? { parentId: n.parentId } : {}),
              data: {
                label: (n as any).label || (n as any).name,
                blockId: n.blockId,
                blockVersion: n.blockVersion,
                nodeType: nodeType,
                runtime: block?.agentRuntime,
                config: (n as any).config ?? {},
                timeoutSeconds: (n as any).timeoutSeconds ?? 120,
              },
            }
          })

          const rfEdges = (pipelineData.edges ?? []).map(e => ({
            id: e.id,
            source: e.sourceNodeId,
            target: e.targetNodeId,
            type: 'conditionalEdge',
            data: {
              isDefault: e.isDefault ?? false,
              condition: e.condition?.expression ?? null,
            },
          }))

          setNodes(sortParentsFirst(rfNodes as Node[]))
          setEdges(rfEdges)
        }
      } catch (e) {
        toast.error(`Failed to load pipeline: ${e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)}`)
      } finally {
        setLoading(false)
      }
    }
    loadData()
  }, [id, isEditMode, versionParam]) // eslint-disable-line react-hooks/exhaustive-deps

  // Update window title - show loaded name for edit mode, placeholder for new mode
  useEffect(() => {
    if (window.axon?.window?.setTitle) {
      // For edit mode: wait for actual pipeline name, or show placeholder
      // For new mode: show "New Pipeline"
      if (isEditMode) {
        // Only show title if we have an actual loaded name (not the default)
        if (pipelineName && pipelineName !== 'Untitled Pipeline') {
          window.axon.window.setTitle(`AXON — ${pipelineName}`)
        }
      } else {
        window.axon.window.setTitle(`AXON — New Pipeline`)
      }
    }
  }, [pipelineName, isEditMode])

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)

  const validationResult = useMemo(() => validate(nodes, edges, blocks), [nodes, edges, blocks])

  const onConnect = useCallback((connection: Connection) => {
    const newEdge: Edge = {
      id: `${connection.source}-${connection.sourceHandle}-${connection.target}-${connection.targetHandle}`,
      source: connection.source!,
      target: connection.target!,
      sourceHandle: connection.sourceHandle,
      targetHandle: connection.targetHandle,
      type: 'conditionalEdge',
      data: { isDefault: false, condition: null },
    }
    setEdges(eds => addEdge(newEdge, eds))
  }, [setEdges])

  const onNewNode = useCallback((d: NewNodeDrop) => {
    if (d.flowType === 'forEach') {
      const fe: Node = {
        id: Date.now().toString(),
        type: 'forEachNode',
        position: d.position,
        style: { width: FOREACH_DEFAULT_SIZE.width, height: FOREACH_DEFAULT_SIZE.height },
        zIndex: -1,
        data: { label: 'ForEach', nodeType: 'forEach', maxItems: 10, onEmpty: 'fail' },
      }
      setNodes(nds => sortParentsFirst([...nds, fe]))
      setSelectedNodeId(fe.id)
      return
    }
    const typeKey = (d.blockType ?? 'Execution').toLowerCase()
    const rfType = typeKey === 'io' ? 'ionode' : `${typeKey}Node`
    setNodes(nds => {
      // Dropped on a ForEach container -> becomes its child (position relative to the container).
      const container = nds.find(n => {
        if (n.type !== 'forEachNode') return false
        const { width, height } = sizeOf(n)
        return d.position.x >= n.position.x && d.position.x <= n.position.x + width && d.position.y >= n.position.y && d.position.y <= n.position.y + height
      })
      const newNode: Node = {
        id: Date.now().toString(),
        type: rfType,
        position: container ? { x: d.position.x - container.position.x, y: d.position.y - container.position.y } : d.position,
        ...(container ? { parentId: container.id } : {}),
        data: {
          label: d.blockName,
          blockId: d.blockId,
          nodeType: d.blockType,
          runtime: d.blockRuntime,
          config: {},
          timeoutSeconds: 120,
        },
      }
      return sortParentsFirst([...nds, newNode])
    })
  }, [setNodes])

  // Drag a block into / out of a ForEach container: set or clear parentId and convert the position
  // between container-relative and absolute. Edges that would now cross the border are dropped.
  const onNodeDragStop = useCallback((_e: unknown, node: Node, getAbs: (id: string) => { x: number; y: number } | undefined, intersecting: Node[]) => {
    if (node.type === 'forEachNode') return
    const target = intersecting[0]
    const newParent = target?.id
    if ((node.parentId ?? undefined) === newParent) return
    const abs = getAbs(node.id) ?? node.position
    const rel = target ? { x: abs.x - target.position.x, y: abs.y - target.position.y } : abs
    setNodes(nds => sortParentsFirst(nds.map(n => {
      if (n.id !== node.id) return n
      const { parentId: _drop, extent: _ext, ...rest } = n as Node & { extent?: unknown }
      return { ...rest, position: rel, ...(newParent ? { parentId: newParent } : {}) } as Node
    })))
    setEdges(eds => {
      const parentOf = (id: string) => (id === node.id ? newParent : nodes.find(n => n.id === id)?.parentId)
      const keep = eds.filter(e => !(e.source === node.id || e.target === node.id) || parentOf(e.source) === parentOf(e.target))
      if (keep.length !== eds.length) toast.info('Connections that would cross the ForEach border were removed')
      return keep
    })
  }, [setNodes, setEdges, nodes])

  const onReconnect = useCallback((oldEdge: Edge, newConnection: Connection) => {
    setEdges(eds => reconnectEdge(oldEdge, newConnection, eds))
  }, [setEdges])

  const isValidConnection = useCallback((connection: Connection | Edge) => {
    const src = connection.sourceHandle
    const tgt = connection.targetHandle
    // Edges never cross a ForEach border: both ends must have the same parent.
    const sp = nodes.find(n => n.id === connection.source)?.parentId
    const tp = nodes.find(n => n.id === connection.target)?.parentId
    if (sp !== tp) return false
    if (src === 'right') return tgt === 'left' || tgt === 'top'
    if (src === 'bottom') return tgt === 'left' || tgt === 'top'
    return false
  }, [nodes])

  const onNodesDelete: OnNodesDelete = useCallback((deleted) => {
    if (deleted.some(n => n.id === selectedNodeId)) setSelectedNodeId(null)
  }, [selectedNodeId])

  const onEdgesDelete: OnEdgesDelete = useCallback(() => {}, [])

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNodeId(node.id)
  }, [])

  const onPaneClick = useCallback(() => { setSelectedNodeId(null); setMenu(null) }, [])

  // Right-click a block: a small menu with Delete (asks first, like the button in the panel).
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  const onNodeContextMenu = useCallback((e: React.MouseEvent, node: Node) => {
    e.preventDefault()
    setSelectedNodeId(node.id)
    if (readOnly) return
    setMenu({ x: e.clientX, y: e.clientY, id: node.id })
  }, [])
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('keydown', close)
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', close) }
  }, [menu])

  // Canvas-only decoration: each ForEach header says which block feeds it.
  const displayNodes = useMemo(() => {
    const shared = toSharedNodes(nodes)
    const sharedEdges = toSharedEdges(edges)
    return nodes.map(n => n.type === 'forEachNode'
      ? { ...n, data: { ...n.data, sourceLabel: forEachSourceLabel(n.id, shared, sharedEdges) ?? null } }
      : n)
  }, [nodes, edges])

  const selectedNode = nodes.find(n => n.id === selectedNodeId) ?? null
  const selectedIsForEach = selectedNode?.type === 'forEachNode'
  // S5 Part B: a Human Gate (Control block) carries its reason, checklist and mode in node.config.
  const selectedIsGate = !selectedIsForEach && blocks.find(b => b.id === (selectedNode?.data as any)?.blockId)?.role === 'Control'
  const gateCfg = readGateConfig(((selectedNode?.data as any)?.config ?? {}) as Record<string, unknown>)
  // S5b: action blocks (Jira Update, PR Update, Find PRs) keep their settings in node.config too.
  const selectedBlock = selectedIsForEach ? undefined : blocks.find(b => b.id === (selectedNode?.data as any)?.blockId)
  const selectedArtifact = selectedIsForEach ? undefined : (blocks.find(b => b.id === (selectedNode?.data as any)?.blockId)?.artifactName as string | undefined)
  function updateGateConfig(patch: Record<string, unknown>) {
    setNodes(nds => nds.map(n => n.id === selectedNodeId
      ? { ...n, data: { ...n.data, config: { ...(((n.data as any).config ?? {}) as Record<string, unknown>), ...patch } } }
      : n))
  }

  // Drafts keep their pins; this explicit action moves every pinned node to the block's current version.
  const outdatedPins = nodes.filter(n => {
    const d = n.data as any
    const blk = blocks.find(b => b.id === d.blockId)
    return d.blockVersion !== undefined && blk && blk.version > d.blockVersion
  })
  function updateBlockVersions() {
    setNodes(nds => nds.map(n => {
      const d = n.data as any
      const blk = blocks.find(b => b.id === d.blockId)
      return d.blockVersion !== undefined && blk && blk.version > d.blockVersion ? { ...n, data: { ...d, blockVersion: blk.version } } : n
    }))
    toast.success(`Updated ${outdatedPins.length} node(s) to the latest block version`)
  }
  const outgoingEdges = edges.filter(e => e.source === selectedNodeId)

  function updateNodeData(key: string, value: unknown) {
    setNodes(nds => nds.map(n =>
      n.id === selectedNodeId ? { ...n, data: { ...n.data, [key]: value } } : n
    ))
  }

  function setDefaultEdge(edgeId: string) {
    setEdges(eds => eds.map(e => {
      if (e.source !== selectedNodeId) return e
      return { ...e, data: { ...(e.data ?? {}), isDefault: e.id === edgeId } }
    }))
  }

  const [confirm, confirmDialog] = useConfirm()
  async function deleteNode(nodeId: string) {
    const node = nodes.find(n => n.id === nodeId)
    const name = node?.type === 'forEachNode' ? 'ForEach' : (blocks.find(b => b.id === (node?.data as any)?.blockId)?.name ?? String((node?.data as any)?.label ?? 'this block'))
    const ok = await confirm({
      title: `Remove "${name}" from this pipeline?`,
      message: 'The block itself is not deleted; it is only taken out of this pipeline together with its connections. Nothing is saved until you press Save.',
      confirmLabel: 'Remove', destructive: true,
    })
    if (!ok) return
    setNodes(nds => nds.filter(n => n.id !== nodeId))
    setEdges(eds => eds.filter(e => e.source !== nodeId && e.target !== nodeId))
    setSelectedNodeId(cur => (cur === nodeId ? null : cur))
  }

  async function handleSave(asDraft: boolean = false) {
    if (!pipelineName.trim()) {
      toast.error('Pipeline name is required')
      return
    }

    // One flat list, parents first; children positions are relative to their ForEach.
    const pipelineNodes = toSharedNodes(nodes) as unknown as PipelineNode[]

    const pipelineEdges: PipelineEdge[] = edges.map(e => ({
      id: e.id,
      sourceNodeId: e.source,
      targetNodeId: e.target,
      isDefault: (e.data as any)?.isDefault ?? false,
      condition: (e.data as any)?.condition
        ? { expression: (e.data as any).condition, targetNodeId: e.target }
        : null,
    }))

    setSaving(true)
    try {
      const req = {
        name: pipelineName,
        description: pipelineDescription,
        nodes: pipelineNodes,
        edges: pipelineEdges,
        onFailure,
        onFailureOnCancel,
      }

      if (isEditMode && id) {
        await updatePipeline(id, req)
      } else {
        await createPipeline(req)
      }

      // Invalidate pipelines query to refresh the list
      queryClient.invalidateQueries({ queryKey: ['pipelines'] })

      toast.success(`Pipeline ${asDraft ? 'saved as draft' : 'saved'}`)
      navigate('/pipelines')
    } catch {
      toast.error('Failed to save pipeline')
    } finally {
      setSaving(false)
    }
  }

  const errorCount = validationResult.errors.length
  const warnCount = validationResult.warnings.length

  return (
    <>
      <style>{`
        .react-flow__controls { background: #1a1f2e !important; border: 1px solid #334155 !important; border-radius: 6px !important; }
        .react-flow__controls-button { background: #1a1f2e !important; border-color: #334155 !important; fill: #94a3b8 !important; }
        .react-flow__controls-button:hover { background: #1e293b !important; }
        .react-flow__controls-button svg { fill: #94a3b8 !important; }
        .react-flow__edge.selected .react-flow__edge-path { stroke: #a78bfa !important; stroke-width: 3 !important; }
        .react-flow__minimap { cursor: grab !important; }
        .react-flow__minimap:active { cursor: grabbing !important; }
        .react-flow__minimap-mask { cursor: grab !important; }
      `}</style>

      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#0f1117' }}>
        {/* Top bar */}
        <div style={{
          height: isEditMode ? 64 : 50, flexShrink: 0,
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '0 16px',
          background: '#111827',
          borderBottom: '1px solid #1e293b',
        }}>
          <button
            onClick={() => navigate(-1)}
            style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 4px' }}
          >
            ←
          </button>

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
            {isEditMode && (
              <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, marginBottom: 1 }}>
                Edit Pipeline
              </div>
            )}
            <input
              value={pipelineName}
              readOnly={readOnly}
              onChange={e => setPipelineName(e.target.value)}
              style={{ background: 'none', border: 'none', outline: 'none', color: '#e2e8f0', fontSize: 15, fontWeight: 700, padding: 0, width: '100%' }}
            />
            <input
              value={pipelineDescription}
              readOnly={readOnly}
              onChange={e => setPipelineDescription(e.target.value)}
              placeholder="Description (optional)"
              style={{ background: 'none', border: 'none', outline: 'none', color: '#64748b', fontSize: 11, padding: 0, width: '100%' }}
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {errorCount > 0 && (
              <span style={{ fontSize: 11, color: '#f87171', background: '#f8717122', border: '1px solid #f8717144', borderRadius: 4, padding: '2px 7px' }}>
                ✕ {errorCount} error{errorCount !== 1 ? 's' : ''}
              </span>
            )}
            {warnCount > 0 && (
              <span style={{ fontSize: 11, color: '#fbbf24', background: '#fbbf2422', border: '1px solid #fbbf2444', borderRadius: 4, padding: '2px 7px' }}>
                ⚠ {warnCount} warn{warnCount !== 1 ? 's' : ''}
              </span>
            )}
            {validationResult.valid && nodes.length > 0 && (
              <span style={{ fontSize: 11, color: '#22d3b8', background: '#22d3b822', border: '1px solid #22d3b844', borderRadius: 4, padding: '2px 7px' }}>
                ✓ Valid
              </span>
            )}
          </div>

          {!readOnly && <button
            onClick={() => handleSave(true)}
            disabled={saving || loading}
            style={{ background: '#1e293b', border: '1px solid #334155', color: '#94a3b8', borderRadius: 6, padding: '4px 12px', fontSize: 12, cursor: saving || loading ? 'default' : 'pointer', opacity: saving || loading ? 0.5 : 1 }}
          >
            {saving ? 'Saving...' : 'Save Draft'}
          </button>}
          {!readOnly && <button
            onClick={() => handleSave(false)}
            disabled={saving || loading}
            style={{ background: '#6f5fe8', border: 'none', color: '#fff', borderRadius: 6, padding: '4px 14px', fontSize: 12, cursor: saving || loading ? 'default' : 'pointer', fontWeight: 600, opacity: saving || loading ? 0.5 : 1 }}
          >
            {saving ? 'Saving...' : 'Save Pipeline'}
          </button>}
        </div>

        {older && (
          <Alert className="rounded-none border-x-0 border-warning/40 bg-warning/10" data-testid="older-version-banner">
            <History />
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3 text-foreground">
              <span>
                You are looking at <strong>version {older.viewing}</strong>, an older version of this pipeline. It is read-only: nothing here can be changed or saved.
                The latest version is v{older.latest}.
              </span>
              <span className="flex gap-2">
                <Button size="sm" onClick={() => navigate(`/pipelines/${id}/edit`, { replace: true })}>Open the latest (editable)</Button>
                <Button size="sm" variant="outline" onClick={() => navigate(-1)}>Back</Button>
              </span>
            </AlertDescription>
          </Alert>
        )}

        {/* Body */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {loading ? (
            <div style={{ width: 240, background: '#111827', borderRight: '1px solid #1e293b', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b' }}>
              Loading blocks…
            </div>
          ) : readOnly ? null : (
            <Palette blocks={blocks} />
          )}

          {/* Canvas */}
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <ReactFlowProvider>
              <FlowCanvas
                nodes={displayNodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onNodeClick={onNodeClick}
                onPaneClick={onPaneClick}
                onNewNode={onNewNode}
                onNodeDragStop={onNodeDragStop}
                onReconnect={onReconnect}
                isValidConnection={isValidConnection}
                onNodesDelete={onNodesDelete}
                onNodeContextMenu={onNodeContextMenu}
                onEdgesDelete={onEdgesDelete}
                readOnly={readOnly}
              />
            </ReactFlowProvider>
          </div>

          {/* Right panel */}
          <PropertiesPanel
            node={selectedNode ? { id: selectedNode.id, data: selectedNode.data as Record<string, unknown> } : null}
            title={selectedIsForEach ? 'ForEach' : (blocks.find(b => b.id === (selectedNode?.data as any)?.blockId)?.name ?? String((selectedNode?.data as any)?.label ?? ''))}
            role={selectedIsForEach ? undefined : (blocks.find(b => b.id === (selectedNode?.data as any)?.blockId)?.role as string | undefined)}
            description={selectedIsForEach ? undefined : (blocks.find(b => b.id === (selectedNode?.data as any)?.blockId)?.description as string | undefined)}
            onClose={() => setSelectedNodeId(null)}
            isForEach={selectedIsForEach}
            isGate={selectedIsGate}
            artifactName={selectedArtifact}
            forEachSource={selectedNode && selectedIsForEach ? (forEachSourceLabel(selectedNode.id, toSharedNodes(nodes), toSharedEdges(edges)) ?? null) : null}
            gate={{ checklist: gateCfg.checklist, mode: gateCfg.mode }}
            onNodeData={updateNodeData}
            onConfig={updateGateConfig}
            onDeleteNode={() => selectedNodeId && void deleteNode(selectedNodeId)}
            inputs={(selectedBlock?.contextRequirements ?? []).map((r: string) => ({ name: contextKey(r), optional: isOptionalContext(r) }))}
            inputsFromAll={selectedBlock?.contextMode === 'Full'}
            outputs={(selectedBlock?.outputSchemaTyped ?? selectedBlock?.outputSchema ?? []).map((e: any) => (typeof e === 'string' ? { name: e } : { name: e.name, type: e.type, itemFields: e.itemFields }))}
            nodeCount={nodes.length}
            readOnly={readOnly}
            edges={outgoingEdges.map(e => ({ id: e.id, source: e.source, target: e.target, isDefault: ((e.data ?? {}) as any).isDefault === true }))}
            onDefaultEdge={setDefaultEdge}
            onFailure={onFailure}
            onFailureChange={setOnFailure}
            onFailureOnCancel={onFailureOnCancel}
            onFailureOnCancelChange={setOnFailureOnCancel}
            errors={validationResult.errors}
            warnings={validationResult.warnings}
            outdatedPins={outdatedPins.length}
            onUpdatePins={updateBlockVersions}
          />
        </div>
      </div>
      {menu && (
        <div
          className="fixed z-50 min-w-40 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
          data-testid="node-context-menu"
        >
          <button
            role="menuitem"
            className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm text-destructive hover:bg-destructive/10"
            onClick={() => void deleteNode(menu.id)}
          >
            Remove from pipeline…
          </button>
        </div>
      )}
      {confirmDialog}
    </>
  )
}
