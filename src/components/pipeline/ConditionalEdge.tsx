import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react'

const ARROW_ID = 'pipeline-arrow'

export default function ConditionalEdge({
  id, sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition,
  data,
  markerEnd,
}: EdgeProps) {
  const [edgePath] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })

  const isDefault = (data as any)?.isDefault !== false
  const stroke = isDefault ? '#6f5fe8' : '#475569'
  const strokeDasharray = isDefault ? undefined : '5,3'

  return (
    <>
      <defs>
        <marker
          id={ARROW_ID}
          markerWidth="10" markerHeight="10"
          refX="8" refY="3"
          orient="auto" markerUnits="strokeWidth"
        >
          <path d="M0,0 L0,6 L9,3 z" fill={stroke} />
        </marker>
      </defs>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{ stroke, strokeWidth: 2, strokeDasharray }}
        markerEnd={`url(#${ARROW_ID})`}
      />
    </>
  )
}
