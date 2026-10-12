import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { ScrollArea } from '../ui/scroll-area'
import { Input } from '../ui/input'
import { Badge } from '../ui/badge'

// Third-party licenses of everything that ships in the app, generated at build time from the production dependencies
// (including the Claude Code binary bundled with the Agent SDK) by scripts/generate-licenses.js.
export function LicensesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['licenses'],
    queryFn: () => window.axon.system.getLicenses(),
    enabled: open,
    staleTime: Infinity,
  })
  const [filter, setFilter] = useState('')
  const packages = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const all = data?.packages ?? []
    return q ? all.filter((p) => p.name.toLowerCase().includes(q) || p.license.toLowerCase().includes(q)) : all
  }, [data, filter])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Third-party licenses</DialogTitle>
          <DialogDescription>
            {data && data.packages.length > 0
              ? `${data.packages.length} packages ship with AXON, including the Electron runtime and the Claude Code binary bundled with the Agent SDK. Chromium's notices are included with the app files.`
              : 'The license list is generated when AXON is built.'}
          </DialogDescription>
        </DialogHeader>
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by package or license" aria-label="Filter licenses" />
        <ScrollArea className="h-[55vh] rounded-lg border">
          <div className="flex flex-col divide-y">
            {isLoading && <p className="p-3 text-sm text-muted-foreground">Loading…</p>}
            {!isLoading && packages.length === 0 && <p className="p-3 text-sm text-muted-foreground">No packages{filter ? ' match' : ' listed'}.</p>}
            {packages.map((p) => (
              <Collapsible key={`${p.name}@${p.version}`}>
                <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50">
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
                  <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
                  <span className="text-xs text-muted-foreground">{p.version}</span>
                  <Badge variant="outline" className="max-w-48 shrink-0 justify-start truncate">{p.license}</Badge>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <pre className="max-h-64 overflow-auto bg-muted/30 px-4 py-3 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
                    {p.text || `No license file was included in this package. Declared license: ${p.license}.`}
                  </pre>
                </CollapsibleContent>
              </Collapsible>
            ))}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
