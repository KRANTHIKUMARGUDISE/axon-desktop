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
import { ACTION_ARTIFACTS } from '@shared'

// S5b: the native action blocks (Jira Update, PR Update, Find PRs) get their own "Actions" group; they are IO blocks otherwise.
const ACTIONS = 'Actions'
const TYPE_ORDER: string[] = [ACTIONS, 'IO', 'Decision', 'Execution', 'Knowledge', 'Control', 'Utility']
const isAction = (b: BuildingBlock) => ACTION_ARTIFACTS.includes(b.artifactName ?? '')

interface Props {
  blocks: BuildingBlock[]
}

function BlockDetailsPopover({ block }: { block: BuildingBlock }) {
  return (
    <div className="w-60 space-y-3">
      <div className="flex items-center gap-2">
        <img
          src={getBlockTypeIcon(block.role as BlockType)}
          alt={block.role}
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
  // Which blocks to list: everything, only the ones shipped with AXON, or only the engineer's own (Local / Marketplace / CDF).
  const [source, setSource] = useState<'all' | 'axon' | 'custom'>('all')
  const [expandedTypes, setExpandedTypes] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {}
    TYPE_ORDER.forEach(t => { initial[t] = true })
    return initial
  })

  const toggleTypeExpanded = (type: string) => {
    setExpandedTypes(prev => ({ ...prev, [type]: !prev[type] }))
  }

  const filtered = blocks.filter(b =>
    (!search || b.name.toLowerCase().includes(search.toLowerCase()))
    && (source === 'all' || (source === 'axon' ? b.sourceType === 'Axon' : b.sourceType !== 'Axon'))
  )

  const showFlow = (source === 'all' || source === 'axon') && (!search || 'foreach flow'.includes(search.toLowerCase()))

  const grouped = TYPE_ORDER.reduce<Record<string, BuildingBlock[]>>((acc, t) => {
    const items = filtered.filter(b => (t === ACTIONS ? isAction(b) : b.role === t && !isAction(b)))
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
        <div className="mt-2 grid grid-cols-3 gap-1 rounded-md bg-slate-800 p-0.5" role="tablist" aria-label="Block source" data-testid="block-source-filter">
          {([['all', 'All'], ['axon', 'AXON'], ['custom', 'Mine']] as const).map(([value, label]) => (
            <button
              key={value}
              role="tab"
              aria-selected={source === value}
              onClick={() => setSource(value)}
              title={value === 'axon' ? 'Blocks that ship with AXON' : value === 'custom' ? 'Blocks you or your team created' : 'All blocks'}
              className={`rounded px-2 py-1 text-xs transition-colors ${source === value ? 'bg-slate-600 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Flow: structural pipeline nodes (D14). They ship with AXON, so they follow the AXON / Mine filter and the search. */}
        {showFlow && <div className="px-3 pt-2 pb-1 text-xs font-bold uppercase tracking-wider text-slate-500">Flow</div>}
        {showFlow && <div
          draggable
          onDragStart={e => {
            e.dataTransfer.setData('flowType', 'forEach')
            e.dataTransfer.effectAllowed = 'copy'
          }}
          className="flex items-center gap-2 px-3 py-2 ml-6 mr-2 mb-2 cursor-grab rounded border border-dashed border-violet-400/50 hover:bg-slate-800 transition-colors"
          title="Runs the blocks inside it once per item of a work list"
        >
          <span className="text-violet-300 text-sm">⟳</span>
          <div className="min-w-0">
            <div className="text-xs font-semibold text-slate-200">ForEach</div>
            <div className="text-xs text-slate-500 truncate">Run its blocks once per work item</div>
          </div>
        </div>}
        {Object.entries(grouped).map(([type, items]) => (
          <div key={type}>
            {/* Type header */}
            <button
              onClick={() => toggleTypeExpanded(type)}
              className="w-full flex items-center gap-2 px-3 py-1.5 border-none bg-transparent cursor-pointer font-inherit hover:bg-slate-800 transition-colors"
            >
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
                    e.dataTransfer.setData('blockType', block.role as string)
                    e.dataTransfer.setData('blockName', block.name)
                    e.dataTransfer.setData('blockRuntime', block.agentRuntime || 'Claude')
                    e.dataTransfer.effectAllowed = 'copy'
                  }}
                  className="flex items-stretch gap-2 px-3 py-2 ml-6 cursor-grab rounded hover:bg-slate-800 transition-colors"
                >
                  {/* Same look as the node on the canvas: the role icon, with the runtime as a small badge in the corner */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="relative h-8 w-8 flex-shrink-0">
                        <img src={getBlockTypeIcon(block.role as BlockType)} alt={block.role} className="h-8 w-8 rounded" />
                        <img
                          src={getRuntimeIcon(blockRuntime)}
                          alt={RUNTIME_LABELS[blockRuntime]}
                          className="absolute -right-1 -top-1 size-3.5 rounded-sm ring-1 ring-slate-900"
                        />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="right" className="text-xs bg-slate-950 border border-slate-700 text-slate-100">
                      {block.role} block · runs on {RUNTIME_LABELS[blockRuntime]}
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
