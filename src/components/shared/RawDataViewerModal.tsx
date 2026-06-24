import { useState } from 'react'
import { ChevronRight, Copy, Check } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@/components/ui/collapsible'

interface RawDataViewerModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  data: string | Record<string, unknown> | unknown[] | null | undefined
}

function valueColorClass(value: unknown): string {
  if (value === null || value === undefined) return 'text-muted-foreground'
  if (typeof value === 'string') return 'text-emerald-500'
  if (typeof value === 'number') return 'text-amber-500'
  if (typeof value === 'boolean') return 'text-violet-500'
  return 'text-foreground'
}

function formatPrimitive(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return `"${value}"`
  return String(value)
}

// Recursive, collapsible JSON tree node. Objects/arrays render as expandable
// rows (default-open one level deep); primitives render inline.
function JsonNode({ keyName, value, depth }: { keyName?: string; value: unknown; depth: number }) {
  const isObject = value !== null && typeof value === 'object' && !Array.isArray(value)
  const isArray = Array.isArray(value)

  if (!isObject && !isArray) {
    return (
      <div className="flex items-start gap-1.5 py-0.5 font-mono text-xs">
        {keyName != null && <span className="text-muted-foreground">{keyName}:</span>}
        <span className={valueColorClass(value)}>{formatPrimitive(value)}</span>
      </div>
    )
  }

  const entries = isArray ? (value as unknown[]).map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>)
  const isEmpty = entries.length === 0
  const bracket = isArray ? ['[', ']'] : ['{', '}']

  if (isEmpty) {
    return (
      <div className="flex items-start gap-1.5 py-0.5 font-mono text-xs">
        {keyName != null && <span className="text-muted-foreground">{keyName}:</span>}
        <span className="text-muted-foreground">{bracket[0]}{bracket[1]}</span>
      </div>
    )
  }

  return (
    <Collapsible defaultOpen={depth < 1} className="font-mono text-xs">
      <CollapsibleTrigger className="group/json-node flex cursor-pointer items-center gap-1 py-0.5 outline-none">
        <ChevronRight className="size-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/json-node:rotate-90" />
        {keyName != null && <span className="text-muted-foreground">{keyName}:</span>}
        <span className="text-muted-foreground">
          {bracket[0]} {entries.length} {isArray ? 'items' : 'fields'} {bracket[1]}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="ml-4 border-l border-border pl-3">
        {entries.map(([k, v]) => (
          <JsonNode key={k} keyName={isArray ? undefined : k} value={v} depth={depth + 1} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}

export default function RawDataViewerModal({ open, onOpenChange, title, data }: RawDataViewerModalProps) {
  const [copied, setCopied] = useState(false)

  let parsed: unknown = data
  let isRawText = false
  if (typeof data === 'string') {
    try {
      parsed = JSON.parse(data)
    } catch {
      isRawText = true
    }
  }

  const copyText = typeof data === 'string' ? data : JSON.stringify(data, null, 2)

  async function handleCopy() {
    await navigator.clipboard.writeText(copyText)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between gap-2 pr-6">
            {title}
            <Button variant="outline" size="sm" onClick={handleCopy}>
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </DialogTitle>
        </DialogHeader>
        <ScrollArea className="h-[60vh] rounded-lg border border-border bg-muted/30 p-3">
          {data == null || (typeof data === 'object' && Object.keys(data).length === 0) ? (
            <div className="p-2 text-xs text-muted-foreground">(empty)</div>
          ) : isRawText ? (
            <pre className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">{data as string}</pre>
          ) : (
            <JsonNode value={parsed} depth={0} />
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
