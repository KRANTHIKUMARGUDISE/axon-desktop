import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { VersionEntry } from '@shared'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { ScopeBadge, StatusBadge } from './ScopeBadge'

export interface VersionTarget {
  kind: 'block' | 'pipeline'
  id: string
  name: string
  scope?: string
  immutable?: boolean
}

// D13 version history + lifecycle actions: Publish (Draft → immutable), Deprecate, Duplicate, and
// Promote (opens a registry pull request for Team / Org).
export function VersionDialog({ target, onClose }: { target: VersionTarget | null; onClose: () => void }) {
  return (
    <Dialog open={!!target} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-xl">
        {target && <VersionPanel target={target} onChanged={() => {}} />}
      </DialogContent>
    </Dialog>
  )
}

function VersionPanel({ target, onChanged }: { target: VersionTarget; onChanged: () => void }) {
  const queryClient = useQueryClient()
  const { kind, id } = target
  const { data: versions = [], isLoading } = useQuery<VersionEntry[]>({
    queryKey: ['versions', kind, id],
    queryFn: () => window.axon.versions.list(kind, id),
  })
  const [label, setLabel] = useState('')
  const [note, setNote] = useState('')
  const [team, setTeam] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [prUrl, setPrUrl] = useState<string | null>(null)

  const owned = !target.immutable && target.scope !== 'Team' && target.scope !== 'Org'
  const draft = versions.find((v) => v.status === 'Draft' && v.source === 'local')
  const published = versions.filter((v) => v.status !== 'Draft')

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ['versions', kind, id] })
    queryClient.invalidateQueries({ queryKey: [kind === 'block' ? 'blocks' : 'pipelines'] })
    onChanged()
  }

  async function run<T>(what: string, fn: () => Promise<T>, ok: (r: T) => void) {
    setBusy(what)
    try {
      ok(await fn())
      refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : `${what} failed`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          {target.name} <ScopeBadge scope={target.scope} />
        </DialogTitle>
        <DialogDescription>
          Version history. Published versions are immutable; editing one starts the next draft.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-1.5 max-h-56 overflow-auto">
        {isLoading && <div className="text-xs" style={{ color: 'var(--axon-t3)' }}>Loading…</div>}
        {versions.map((v) => (
          <div key={`${v.source}-${v.version}`} className="flex items-center gap-2 text-xs rounded-md px-2.5 py-1.5" style={{ background: 'var(--axon-bg3)', color: 'var(--axon-t2)' }}>
            <strong style={{ color: 'var(--axon-t1)' }}>v{v.version}</strong>
            {v.versionLabel && <span>{v.versionLabel}</span>}
            <StatusBadge status={v.status} />
            <span className="truncate flex-1" style={{ color: 'var(--axon-t3)' }}>{v.changeNote ?? ''}</span>
            <span style={{ color: 'var(--axon-t4)' }}>{v.source === 'registry' ? 'registry' : 'local'}</span>
            <span style={{ color: 'var(--axon-t4)' }}>{new Date(v.updatedAt).toLocaleDateString()}</span>
          </div>
        ))}
        {!isLoading && versions.length === 0 && <div className="text-xs" style={{ color: 'var(--axon-t3)' }}>No versions yet.</div>}
      </div>

      {owned && draft && (
        <div className="space-y-2 pt-1">
          <div className="text-xs font-semibold" style={{ color: 'var(--axon-t1)' }}>Publish v{draft.version}</div>
          <div className="flex gap-2">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (optional, e.g. 1.0)" maxLength={60} />
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed?" maxLength={500} />
          </div>
          <Button
            size="sm"
            disabled={!!busy}
            onClick={() => run('Publish', () => window.axon.versions.publish(kind, id, { versionLabel: label || undefined, changeNote: note || undefined }),
              () => { toast.success(`Published v${draft.version}`); setLabel(''); setNote('') })}
          >
            {busy === 'Publish' ? 'Publishing…' : `Publish v${draft.version}`}
          </Button>
        </div>
      )}

      <div className="flex flex-wrap gap-2 pt-2 border-t" style={{ borderColor: 'var(--axon-border)' }}>
        {!target.immutable && (
          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => run('Duplicate', () => window.axon.versions.duplicate(kind, id), () => toast.success('Duplicated as a new Personal draft'))}>
            Duplicate to Personal
          </Button>
        )}
        {owned && published.some((v) => v.status === 'Published') && (
          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => run('Deprecate', () => window.axon.versions.deprecate(kind, id), () => toast.success('Latest published version deprecated'))}>
            Deprecate latest
          </Button>
        )}
      </div>

      {owned && published.some((v) => v.status === 'Published') && (
        <div className="space-y-2 pt-2 border-t" style={{ borderColor: 'var(--axon-border)' }}>
          <div className="text-xs font-semibold" style={{ color: 'var(--axon-t1)' }}>Promote the latest published version</div>
          <p className="text-xs" style={{ color: 'var(--axon-t3)' }}>
            Opens a pull request to the registry — Team and Org content only changes when the PR is merged. Needs your GitHub token.
          </p>
          <div className="flex gap-2">
            <Input value={team} onChange={(e) => setTeam(e.target.value)} placeholder="Team name" maxLength={60} className="max-w-[160px]" />
            <Button size="sm" variant="outline" disabled={!!busy || !team.trim()}
              onClick={() => run('Promote', () => window.axon.versions.promote(kind, id, { scope: 'Team', team: team.trim() }), (r) => setPrUrl(r.prUrl))}>
              {busy === 'Promote' ? 'Opening PR…' : 'Promote to Team'}
            </Button>
            <Button size="sm" variant="outline" disabled={!!busy}
              onClick={() => run('Promote', () => window.axon.versions.promote(kind, id, { scope: 'Org' }), (r) => setPrUrl(r.prUrl))}>
              Promote to Org
            </Button>
          </div>
          {prUrl && (
            <div className="text-xs" style={{ color: 'var(--axon-green, #34d399)' }}>
              Pull request opened:{' '}
              <a href={prUrl} onClick={(e) => { e.preventDefault(); void window.axon.shell.openExternal(prUrl) }} style={{ textDecoration: 'underline', cursor: 'pointer' }}>
                {prUrl}
              </a>
            </div>
          )}
        </div>
      )}
    </>
  )
}
