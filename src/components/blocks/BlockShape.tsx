import type { BlockType } from '../../types'

const COLORS: Record<BlockType, string> = {
  Decision:  '#f472b6',
  Execution: '#38bdf8',
  Knowledge: '#22d3b8',
  Control:   '#f59e0b',
  Utility:   '#a78bfa',
  IO:        '#34d399',
}

interface Props {
  type: BlockType
  size?: number
}

export default function BlockShape({ type, size = 32 }: Props) {
  const color = COLORS[type]
  const s = size

  const shape = () => {
    switch (type) {
      case 'Decision':
        return (
          <polygon
            points={`${s/2},${s*0.06} ${s*0.94},${s/2} ${s/2},${s*0.94} ${s*0.06},${s/2}`}
            fill="none" stroke={color} strokeWidth="2"
          />
        )
      case 'Execution':
        return (
          <rect
            x={s*0.06} y={s*0.12} width={s*0.88} height={s*0.76}
            rx={s*0.09} ry={s*0.09}
            fill="none" stroke={color} strokeWidth="2"
          />
        )
      case 'Knowledge': {
        const cx = s / 2, cy = s / 2, r = s * 0.44
        const pts = Array.from({ length: 6 }, (_, i) => {
          const a = (Math.PI / 3) * i - Math.PI / 6
          return `${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`
        }).join(' ')
        return <polygon points={pts} fill="none" stroke={color} strokeWidth="2" />
      }
      case 'Control':
        return (
          <circle
            cx={s/2} cy={s/2} r={s*0.41}
            fill="none" stroke={color} strokeWidth="2"
          />
        )
      case 'Utility':
        return (
          <rect
            x={s*0.06} y={s*0.25} width={s*0.88} height={s*0.5}
            rx={s*0.25} ry={s*0.25}
            fill="none" stroke={color} strokeWidth="2"
          />
        )
      case 'IO':
        return (
          <rect
            x={s*0.06} y={s*0.15} width={s*0.88} height={s*0.7}
            rx={s*0.34} ry={s*0.34}
            fill="none" stroke={color} strokeWidth="2.5"
          />
        )
    }
  }

  return (
    <svg width={size} height={size} viewBox={`0 0 ${s} ${s}`} style={{ flexShrink: 0 }}>
      {shape()}
    </svg>
  )
}
