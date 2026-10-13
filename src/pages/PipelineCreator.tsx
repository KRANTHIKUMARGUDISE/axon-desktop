import '@xyflow/react/dist/style.css'
import { useState, useCallback, useMemo, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap,
  useNodesState, useEdgesState, useReactFlow, addEdge, reconnectEdge,
  type Node, type Edge, type Connection, type NodeTypes, type EdgeTypes,
  type OnNodesDelete, type OnEdgesDelete,
} from '@xyflow/react'
import { toast } from 'sonner'
import { validatePipeline, toPipelineNodes, parentsFirst, canvasNodeSize, forEachSourceLabel, FOREACH_DEFAULT_SIZE, describeHandoff, effectiveItemFields } from '@shared'
import type { PipelineNode as SharedNode, PipelineEdge as SharedEdge, CanvasNode } from '@shared'
import { getBlocks } from '../services/blocksService'
import { getPipeline, createPipeline, updatePipeline } from '../services/pipelinesService'
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
}

function FlowCanvas({
  nodes, edges, onNodesChange, onEdgesChange, onConnect, onReconnect,
  isValidConnection, onNodeClick, onPaneClick, onNewNode, onNodeDragStop, onNodesDelete, onEdgesDelete,
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
      onDrop={onDrop}
      onDragOver={onDragOver}
      onNodeClick={onNodeClick}
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
      deleteKeyCode="Delete"
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
  const [pipelineName, setPipelineName] = useState('Untitled Pipeline')
  const [pipelineDescription, setPipelineDescription] = useState('')
  const [blocks, setBlocks] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  useEffect(() => {
    async function loadData() {
      setLoading(true)
      try {
        const [blocksData, pipelineData] = await Promise.all([
          getBlocks(),
          isEditMode && id ? getPipeline(id) : Promise.resolve(null),
        ])
        setBlocks(blocksData)

        if (pipelineData) {
          setPipelineName(pipelineData.name)
          setPipelineDescription(pipelineData.description ?? '')

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
        toast.error('Failed to load pipeline')
      } finally {
        setLoading(false)
      }
    }
    loadData()
  }, [id, isEditMode]) // eslint-disable-line react-hooks/exhaustive-deps

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

  const onPaneClick = useCallback(() => setSelectedNodeId(null), [])

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

  // Handoff contract of an edge, e.g. "Demo Planner → Workspace Provisioner: WorkItemList (key, task, repo)".
  function handoffText(sourceId: string, targetId: string): string {
    const nodeById = (id: string) => nodes.find(n => n.id === id)?.data as any
    const src = nodeById(sourceId)
    const dst = nodeById(targetId)
    const srcBlock = blocks.find(b => b.id === src?.blockId)
    const sharedNodes = toSharedNodes(nodes)
    const srcNode = sharedNodes.find(n => n.id === sourceId)
    const blockMap = new Map(blocks.map(b => [b.id, { id: b.id, role: b.role, artifactName: b.artifactName, outputSchema: b.outputSchemaTyped ?? b.outputSchema }]))
    return describeHandoff(
      { name: src?.label ?? sourceId, block: { outputSchema: srcBlock?.outputSchemaTyped } },
      dst?.label ?? targetId,
      srcNode ? effectiveItemFields(srcNode, sharedNodes, toSharedEdges(edges), blockMap as any) : undefined,
    )
  }

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

  function deleteSelectedNode() {
    if (!selectedNodeId) return
    setNodes(nds => nds.filter(n => n.id !== selectedNodeId))
    setEdges(eds => eds.filter(e => e.source !== selectedNodeId && e.target !== selectedNodeId))
    setSelectedNodeId(null)
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
              onChange={e => setPipelineName(e.target.value)}
              style={{ background: 'none', border: 'none', outline: 'none', color: '#e2e8f0', fontSize: 15, fontWeight: 700, padding: 0, width: '100%' }}
            />
            <input
              value={pipelineDescription}
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

          <button
            onClick={() => handleSave(true)}
            disabled={saving || loading}
            style={{ background: '#1e293b', border: '1px solid #334155', color: '#94a3b8', borderRadius: 6, padding: '4px 12px', fontSize: 12, cursor: saving || loading ? 'default' : 'pointer', opacity: saving || loading ? 0.5 : 1 }}
          >
            {saving ? 'Saving...' : 'Save Draft'}
          </button>
          <button
            onClick={() => handleSave(false)}
            disabled={saving || loading}
            style={{ background: '#6f5fe8', border: 'none', color: '#fff', borderRadius: 6, padding: '4px 14px', fontSize: 12, cursor: saving || loading ? 'default' : 'pointer', fontWeight: 600, opacity: saving || loading ? 0.5 : 1 }}
          >
            {saving ? 'Saving...' : 'Save Pipeline'}
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {loading ? (
            <div style={{ width: 240, background: '#111827', borderRight: '1px solid #1e293b', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b' }}>
              Loading blocks…
            </div>
          ) : (
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
                onEdgesDelete={onEdgesDelete}
              />
            </ReactFlowProvider>
          </div>

          {/* Right panel */}
          <div style={{
            width: 210, flexShrink: 0,
            background: '#111827',
            borderLeft: '1px solid #1e293b',
            display: 'flex', flexDirection: 'column',
            overflowY: 'auto', padding: 10,
            gap: 12,
          }}>
            {selectedNode && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    Node Properties
                  </div>
                  <button
                    onClick={deleteSelectedNode}
                    title="Delete node"
                    style={{
                      background: '#7f1d1d44', border: '1px solid #991b1b66', color: '#f87171',
                      borderRadius: 4, padding: '2px 7px', fontSize: 11, cursor: 'pointer',
                    }}
                  >
                    Delete
                  </button>
                </div>

                <label style={{ fontSize: 11, color: '#64748b' }}>
                  Name
                  <input
                    value={(selectedNode.data as any).label}
                    onChange={e => updateNodeData('label', e.target.value)}
                    style={inputStyle}
                  />
                </label>

                {selectedIsForEach && (
                  <>
                    <div style={{ fontSize: 10, color: '#94a3b8', lineHeight: 1.4 }}>
                      {forEachSourceLabel(selectedNode.id, toSharedNodes(nodes), toSharedEdges(edges))
                        ? `Runs once per item from ${forEachSourceLabel(selectedNode.id, toSharedNodes(nodes), toSharedEdges(edges))}.`
                        : 'Connect a block that returns a work-item list.'}
                    </div>
                    <details>
                      <summary style={{ fontSize: 11, color: '#94a3b8', cursor: 'pointer' }}>Advanced</summary>
                      <label style={{ fontSize: 11, color: '#64748b', display: 'block', marginTop: 6 }}>
                        Max items
                        <input type="number" min={1} value={(selectedNode.data as any).maxItems ?? 10} onChange={e => updateNodeData('maxItems', Math.max(1, Number(e.target.value) || 1))} style={inputStyle} />
                      </label>
                      <label style={{ fontSize: 11, color: '#64748b', display: 'block', marginTop: 6 }}>
                        If the list is empty
                        <select value={(selectedNode.data as any).onEmpty ?? 'fail'} onChange={e => updateNodeData('onEmpty', e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
                          <option value="fail">Fail the run</option>
                          <option value="skip">Skip the ForEach</option>
                        </select>
                      </label>
                    </details>
                  </>
                )}

                {!selectedIsForEach && (<>
                <label style={{ fontSize: 11, color: '#64748b' }}>
                  Block ID
                  <input
                    value={(selectedNode.data as any).blockId}
                    readOnly
                    style={{ ...inputStyle, color: '#475569', cursor: 'default' }}
                  />
                </label>

                <label style={{ fontSize: 11, color: '#64748b' }}>
                  Timeout (s)
                  <input
                    type="number"
                    value={(selectedNode.data as any).timeoutSeconds ?? 120}
                    onChange={e => updateNodeData('timeoutSeconds', Number(e.target.value))}
                    style={inputStyle}
                  />
                </label>
                </>)}

                {outgoingEdges.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 4 }}>
                      Outgoing Edges
                    </div>
                    {outgoingEdges.map(edge => {
                      const ed = (edge.data ?? {}) as any
                      return (
                        <div key={edge.id} style={{
                          background: '#1a1f2e', border: '1px solid #1e293b',
                          borderRadius: 6, padding: 8, display: 'flex', flexDirection: 'column', gap: 5,
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <div data-testid="handoff-contract" style={{ fontSize: 10, color: '#64748b' }}>{handoffText(edge.source, edge.target)}</div>
                            <button
                              onClick={() => setEdges(eds => eds.filter(e => e.id !== edge.id))}
                              style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer', fontSize: 12, lineHeight: 1 }}
                              title="Delete edge"
                            >
                              ✕
                            </button>
                          </div>
                          <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#94a3b8', cursor: 'pointer' }}>
                            <input
                              type="radio"
                              name={`default-${selectedNodeId}`}
                              checked={ed.isDefault === true}
                              onChange={() => setDefaultEdge(edge.id)}
                            />
                            Default route
                          </label>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Validation */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Validation
              </div>
              <ValidationRow label="Start node" pass={!validationResult.errors.some(e => e.includes('start node'))} isError />
              <ValidationRow label="Workspace before agents / PRs" pass={!validationResult.errors.some(e => e.includes('Workspace Provisioner'))} isError />
              <ValidationRow label="ForEach is well-formed" pass={!validationResult.errors.some(e => e.includes('ForEach'))} isError />
              <ValidationRow label="Branch nodes have default" pass={!validationResult.errors.some(e => e.includes('default route'))} isError />
              {outdatedPins.length > 0 && (
                <button
                  onClick={updateBlockVersions}
                  style={{ background: '#1e293b', border: '1px solid #334155', color: '#94a3b8', borderRadius: 4, padding: '3px 8px', fontSize: 10, cursor: 'pointer', textAlign: 'left' }}
                  title="Pins stay as saved until you choose to update them"
                >
                  Update block versions ({outdatedPins.length} newer)
                </button>
              )}
              {validationResult.errors.map((err, i) => (
                <div key={i} style={{ fontSize: 10, color: '#f87171', paddingLeft: 4 }}>{err}</div>
              ))}
              {validationResult.warnings.map((w, i) => (
                <div key={i} style={{ fontSize: 10, color: '#fbbf24', paddingLeft: 4 }}>{w}</div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

function ValidationRow({ label, pass, isError }: { label: string; pass: boolean; isError: boolean }) {
  const icon = pass ? '✅' : isError ? '✕' : '⚠️'
  const color = pass ? '#22d3b8' : isError ? '#f87171' : '#fbbf24'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color }}>
      <span>{icon}</span>
      <span style={{ color: '#94a3b8' }}>{label}</span>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  display: 'block', width: '100%', marginTop: 2,
  background: '#1a1f2e', border: '1px solid #334155',
  borderRadius: 4, color: '#e2e8f0', fontSize: 11,
  padding: '4px 7px', outline: 'none',
  boxSizing: 'border-box',
}
