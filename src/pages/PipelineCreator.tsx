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
import ConditionalEdge from '../components/pipeline/ConditionalEdge'

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

const OPERATORS = ['>=', '<=', '==', '!=', 'exists', 'not-exists']

function validate(nodes: Node[], edges: Edge[]): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  const incomingIds = new Set(edges.map(e => e.target))
  const outgoingIds = new Set(edges.map(e => e.source))

  const ioNodes = nodes.filter(n => n.data?.nodeType === 'IO')
  const hasStart = ioNodes.some(n => !incomingIds.has(n.id))

  if (!hasStart) errors.push('No IO start node (node with no incoming edges)')

  const disconnected = nodes.filter(n => !incomingIds.has(n.id) && !outgoingIds.has(n.id))
  if (disconnected.length) warnings.push(`${disconnected.length} disconnected node(s): ${disconnected.map(n => n.data?.label).join(', ')}`)

  for (const n of nodes) {
    const outs = edges.filter(e => e.source === n.id)
    if (outs.length > 1) {
      const hasDefault = outs.some(e => (e.data as any)?.isDefault === true)
      if (!hasDefault) errors.push(`Node "${n.data?.label}" has multiple outgoing edges but no default route`)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

// Inner component so useReactFlow works (must be inside ReactFlowProvider)
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
  onNewNode: (d: { blockId: string; blockType: BlockType; blockName: string; blockRuntime?: string; position: { x: number; y: number } }) => void
  onNodesDelete: OnNodesDelete
  onEdgesDelete: OnEdgesDelete
}

function FlowCanvas({
  nodes, edges, onNodesChange, onEdgesChange, onConnect, onReconnect,
  isValidConnection, onNodeClick, onPaneClick, onNewNode, onNodesDelete, onEdgesDelete,
}: FlowCanvasProps) {
  const { screenToFlowPosition } = useReactFlow()

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
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
              data: {
                label: (n as any).label || (n as any).name,
                blockId: n.blockId,
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

          setNodes(rfNodes)
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

  const validationResult = useMemo(() => validate(nodes, edges), [nodes, edges])

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

  const onNewNode = useCallback((d: { blockId: string; blockType: BlockType; blockName: string; blockRuntime?: string; position: { x: number; y: number } }) => {
    const typeKey = d.blockType.toLowerCase()
    const rfType = typeKey === 'io' ? 'ionode' : `${typeKey}Node`
    const newNode: Node = {
      id: Date.now().toString(),
      type: rfType,
      position: d.position,
      data: {
        label: d.blockName,
        blockId: d.blockId,
        nodeType: d.blockType,
        runtime: d.blockRuntime,
        config: {},
        timeoutSeconds: 120,
      },
    }
    setNodes(nds => [...nds, newNode])
  }, [setNodes])

  const onReconnect = useCallback((oldEdge: Edge, newConnection: Connection) => {
    setEdges(eds => reconnectEdge(oldEdge, newConnection, eds))
  }, [setEdges])

  const isValidConnection = useCallback((connection: Connection | Edge) => {
    const src = connection.sourceHandle
    const tgt = connection.targetHandle
    if (src === 'right') return tgt === 'left' || tgt === 'top'
    if (src === 'bottom') return tgt === 'left' || tgt === 'top'
    return false
  }, [])

  const onNodesDelete: OnNodesDelete = useCallback((deleted) => {
    if (deleted.some(n => n.id === selectedNodeId)) setSelectedNodeId(null)
  }, [selectedNodeId])

  const onEdgesDelete: OnEdgesDelete = useCallback(() => {}, [])

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNodeId(node.id)
  }, [])

  const onPaneClick = useCallback(() => setSelectedNodeId(null), [])

  const selectedNode = nodes.find(n => n.id === selectedNodeId) ?? null
  const outgoingEdges = edges.filter(e => e.source === selectedNodeId)

  function updateNodeData(key: string, value: unknown) {
    setNodes(nds => nds.map(n =>
      n.id === selectedNodeId ? { ...n, data: { ...n.data, [key]: value } } : n
    ))
  }

  function updateEdge(edgeId: string, patch: Record<string, unknown>) {
    setEdges(eds => eds.map(e =>
      e.id === edgeId ? { ...e, data: { ...(e.data ?? {}), ...patch } } : e
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

    const pipelineNodes: PipelineNode[] = nodes.map(n => ({
      id: n.id,
      type: (n.data as any).nodeType as BlockType,
      name: (n.data as any).label,
      blockId: (n.data as any).blockId,
      label: (n.data as any).label,
      positionX: n.position.x,
      positionY: n.position.y,
      position: n.position,
      config: (n.data as any).config ?? {},
      timeoutSeconds: (n.data as any).timeoutSeconds ?? 120,
    }))

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
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onNodeClick={onNodeClick}
                onPaneClick={onPaneClick}
                onNewNode={onNewNode}
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
                            <div style={{ fontSize: 10, color: '#64748b' }}>→ {edge.target}</div>
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
                          {!ed.isDefault && (
                            <>
                              <input
                                value={ed.field ?? ''}
                                onChange={e => updateEdge(edge.id, { field: e.target.value })}
                                placeholder="output.score"
                                style={inputStyle}
                              />
                              <select
                                value={ed.operator ?? '=='}
                                onChange={e => updateEdge(edge.id, { operator: e.target.value })}
                                style={{ ...inputStyle, cursor: 'pointer' }}
                              >
                                {OPERATORS.map(op => (
                                  <option key={op} value={op}>{op}</option>
                                ))}
                              </select>
                              {!['exists', 'not-exists'].includes(ed.operator ?? '') && (
                                <input
                                  value={ed.value ?? ''}
                                  onChange={e => updateEdge(edge.id, { value: e.target.value })}
                                  placeholder="80"
                                  style={inputStyle}
                                />
                              )}
                            </>
                          )}
                          <button
                            onClick={() => console.log('Sync from Marketplace:', edge.id)}
                            style={{ background: 'none', border: '1px solid #334155', color: '#64748b', borderRadius: 4, padding: '2px 8px', fontSize: 10, cursor: 'pointer', marginTop: 2 }}
                          >
                            Sync from Marketplace
                          </button>
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
              <ValidationRow label="IO start node" pass={!validationResult.errors.some(e => e.includes('start'))} isError />
              <ValidationRow label="No disconnected nodes" pass={validationResult.warnings.length === 0} isError={false} />
              <ValidationRow label="Branch nodes have default" pass={!validationResult.errors.some(e => e.includes('default route'))} isError />
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
