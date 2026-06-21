import { useState } from 'react'
import type { BuildingBlock, BlockType } from '../../types'
import { getBlockTypeIcon } from '../../utils/blockTypeIcons'
import { getRuntimeIcon, RUNTIME_LABELS } from '../../utils/runtimeIcons'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

const TYPE_ORDER: BlockType[] = ['IO', 'Decision', 'Execution', 'Knowledge', 'Control', 'Utility']

interface Props {
  blocks: BuildingBlock[]
}

function BlockDetailsPopover({ block }: { block: BuildingBlock }) {
  return (
    <div className="w-60 space-y-3">
      <div className="flex items-center gap-2">
        <img
          src={getBlockTypeIcon((block.role || block.type) as BlockType)}
          alt={block.role || block.type}
          className="size-5 rounded"
        />
        <span className="font-bold text-sm text-slate-200">{block.name}</span>
      </div>

      <p className="text-xs text-slate-400 leading-relaxed">
        {block.description}
      </p>

      <div className="flex gap-2 text-xs text-slate-500 border-t border-slate-700 pt-2">
        <span>v{block.version}</span>
        {block.verified && <span className="text-teal-400">✓ Verified</span>}
        <span className="ml-auto">{block.usageCount} uses</span>
      </div>

      {block.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {block.tags.map(tag => (
            <span
              key={tag}
              className="text-xs bg-slate-900 border border-slate-700 text-slate-500 rounded px-1.5 py-0.5"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

export default function Palette({ blocks }: Props) {
  const [search, setSearch] = useState('')
  const [expandedTypes, setExpandedTypes] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {}
    TYPE_ORDER.forEach(t => { initial[t] = true })
    return initial
  })

  const toggleTypeExpanded = (type: string) => {
    setExpandedTypes(prev => ({ ...prev, [type]: !prev[type] }))
  }

  const filtered = blocks.filter(b =>
    !search || b.name.toLowerCase().includes(search.toLowerCase())
  )

  const grouped = TYPE_ORDER.reduce<Record<string, BuildingBlock[]>>((acc, t) => {
    const items = filtered.filter(b => (b.role || b.type) === t)
    if (items.length) acc[t] = items
    return acc
  }, {})

  return (
    <div className="flex flex-col h-full shrink-0 bg-slate-900 border-r border-slate-800" style={{ width: 260 }}>
      <div className="p-2 border-b border-slate-800">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search blocks…"
          className="w-full px-2 py-1 text-xs bg-slate-800 border border-slate-700 rounded text-slate-200 placeholder-slate-500 outline-none"
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        {Object.entries(grouped).map(([type, items]) => (
          <div key={type}>
            {/* Type header */}
            <button
              onClick={() => toggleTypeExpanded(type)}
              className="w-full flex items-center gap-2 px-3 py-2 border-none bg-transparent cursor-pointer font-inherit hover:bg-slate-800 transition-colors"
            >
              <img
                src={getBlockTypeIcon(type as BlockType)}
                alt={type}
                className="size-4 rounded flex-shrink-0"
              />
              <span className="text-xs font-bold uppercase tracking-wider text-slate-500 flex-1 text-left">
                {type}
              </span>
              <span className="text-xs text-slate-500 flex-shrink-0">
                {expandedTypes[type] ? '▼' : '▶'} ({items.length})
              </span>
            </button>

            {/* Block items */}
            {expandedTypes[type] && items.map(block => {
              const blockRuntime = block.agentRuntime || 'Claude'
              return (
                <div
                  key={block.id}
                  draggable
                  onDragStart={e => {
                    e.dataTransfer.setData('blockId', block.id)
                    e.dataTransfer.setData('blockType', (block.role || block.type) as string)
                    e.dataTransfer.setData('blockName', block.name)
                    e.dataTransfer.setData('blockRuntime', block.agentRuntime || 'Claude')
                    e.dataTransfer.effectAllowed = 'copy'
                  }}
                  className="flex items-stretch gap-2 px-3 py-2 ml-6 cursor-grab rounded hover:bg-slate-800 transition-colors"
                >
                  {/* Runtime icon — spans both lines */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <img
                        src={getRuntimeIcon(blockRuntime)}
                        alt={RUNTIME_LABELS[blockRuntime]}
                        className="w-8 h-8 rounded flex-shrink-0"
                      />
                    </TooltipTrigger>
                    <TooltipContent side="right" className="text-xs bg-slate-950 border border-slate-700 text-slate-100">
                      {RUNTIME_LABELS[blockRuntime]}
                    </TooltipContent>
                  </Tooltip>

                  {/* Block name and description */}
                  <div className="flex-1 min-w-0 flex flex-col justify-center gap-1">
                    <div className="text-xs font-semibold text-slate-200 truncate">
                      {block.name}
                    </div>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="text-xs text-slate-500 truncate">
                          {block.description || '(no description)'}
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="right" className="max-w-xs text-xs">
                        {block.description || '(no description)'}
                      </TooltipContent>
                    </Tooltip>
                  </div>

                  {/* Version and menu */}
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <span className="text-xs text-slate-500">v{block.version}</span>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0 text-slate-500 hover:text-slate-300"
                        >
                          ⋮
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48">
                        <DropdownMenuItem asChild>
                          <div className="p-3 cursor-default hover:bg-transparent active:bg-transparent focus:bg-transparent">
                            <BlockDetailsPopover block={block} />
                          </div>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
