import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueries, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { FolderOpen, Pause, Play, Plus, Radar } from 'lucide-react'
import type { DeliveryRule, VersionEntry, WatcherInfo } from '@shared'
import { usePipelines } from '@/hooks/usePipelines'
import { useDeliveries } from '@/hooks/useDeliveries'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { RuleRow } from '@/components/automation/RuleRow'
import { UpdateVersionDialog } from '@/components/automation/UpdateVersionDialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldRow, Notice, SettingsCard, cleanError } from '@/components/settings/parts'

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never')

/** "3 min ago" / "2 h ago" / "never" */
function ago(iso: string | null): string {
  if (!iso) return 'never'
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000))
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  if (min < 24 * 60) return `${Math.round(min / 60)} h ago`
  return `${Math.round(min / 1440)} d ago`
}
function inMinutes(iso: string | null): string {
  if (!iso) return 'on the next check'
  const min = Math.round((Date.parse(iso) - Date.now()) / 60_000)
  return min <= 0 ? 'any moment' : min < 60 ? `in ${min} min` : `in ${Math.round(min / 60)} h`
}

function useWatcher() {
  return useQuery<WatcherInfo>({ queryKey: ['watcher'], queryFn: () => window.axon.watcher.status(), refetchInterval: 15_000 })
}

// Automation (S5 Part A, S5b): rules start a pipeline when something happens in Jira. A rule is only the trigger; what changes
// in Jira and GitHub is decided by the action blocks in its pipeline. Rules run on the one active machine (D10) and
// "Pause all" (stored on the profile) stops them everywhere.
export default function Rules() {
  useEffect(() => { window.axon?.window?.setTitle?.('AXON — Automation') }, [])
  const qc = useQueryClient()
  const { data: watcher } = useWatcher()
  const { data: rules = [] } = useQuery<DeliveryRule[]>({ queryKey: ['rules'], queryFn: () => window.axon.rules.list() })
  const { data: pipelines = [] } = usePipelines(undefined)
  const [editing, setEditing] = useState<DeliveryRule | 'new' | null>(null)
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()
  // ?rule=<id> (from a delivery): that rule opens and flashes; the parameter is dropped afterwards so a refresh does not repeat it.
  const [searchParams, setSearchParams] = useSearchParams()
  const highlightId = searchParams.get('rule')
  useEffect(() => {
    if (!highlightId) return
    const t = setTimeout(() => setSearchParams({}, { replace: true }), 3200)
    return () => clearTimeout(t)
  }, [highlightId]) // eslint-disable-line react-hooks/exhaustive-deps
  const [query, setQuery] = useState('')
  // The Jira site chosen at onboarding (a read-only setting), for "Open in Jira" links.
  const { data: jiraSite } = useQuery({ queryKey: ['jira-site'], queryFn: () => window.axon.settings.get('jiraSite') as Promise<string> })
  const jiraBase = typeof jiraSite === 'string' && jiraSite ? `https://${jiraSite}` : null
  const [updating, setUpdating] = useState<{ rule: DeliveryRule; version: number } | null>(null)
  // Deliveries started by rules, newest first, grouped per rule (the page shows the latest few; the Deliveries screen has the full list).
  const { data: allDeliveries } = useDeliveries({ page: 1, pageSize: 100_000 })
  const byRule = new Map<string, NonNullable<typeof allDeliveries>['items']>()
  for (const d of [...(allDeliveries?.items ?? [])].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))) {
    if (d.trigger === 'Watcher' && d.ruleId) byRule.set(d.ruleId, [...(byRule.get(d.ruleId) ?? []), d])
  }

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['rules'] })
    qc.invalidateQueries({ queryKey: ['watcher'] })
  }

  // Published versions per pinned pipeline → "newer pipeline version available".
  const versionQueries = useQueries({
    queries: rules.map((r) => ({
      queryKey: ['pipeline-versions', r.pipelineId],
      queryFn: () => window.axon.versions.list('pipeline', r.pipelineId),
      staleTime: 0,
      refetchOnMount: 'always' as const,
    })),
  })
  const latestPublished = (i: number): number | null => {
    const published = (versionQueries[i]?.data as VersionEntry[] | undefined)?.filter((v) => v.status === 'Published').map((v) => v.version) ?? []
    return published.length ? Math.max(...published) : null
  }

  // Pin the rule to a newer published version in one step. The rule keeps its enabled state; the save runs the usual checks
  // (pipeline valid, inputs provided, Jira permissions when enabled) and refuses with the reason if the new version cannot run.
  async function updateVersion(rule: DeliveryRule, version: number) {
    await run(
      () => window.axon.rules.save({
        id: rule.id, name: rule.name, source: rule.source, enabled: rule.enabled, jiraProjectKey: rule.jiraProjectKey,
        readyLabel: rule.readyLabel, ...(rule.readyStatus ? { readyStatus: rule.readyStatus } : {}), pipelineId: rule.pipelineId, pipelineVersion: version,
        ...(rule.defaultWorkspacePath ? { defaultWorkspacePath: rule.defaultWorkspacePath } : {}),
        pollIntervalMinutes: rule.pollIntervalMinutes, postOutcomeComment: rule.postOutcomeComment,
      }),
      `"${rule.name}" now runs v${version}`,
    )
  }

  async function run<T>(fn: () => Promise<T>, ok?: string) {
    setBusy(true)
    try {
      const r = await fn()
      // The watcher handlers return the fresh status: show it at once instead of waiting for the next refetch.
      if (r && typeof r === 'object' && 'role' in r && 'paused' in r) qc.setQueryData(['watcher'], r)
      if (ok) toast.success(ok)
      refresh()
      return r
    } catch (e) {
      toast.error(cleanError(e))
      refresh() // drop any optimistic state
    } finally {
      setBusy(false)
    }
  }

  const role = watcher?.role
  const visibleRules = rules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => {
      const q = query.trim().toLowerCase()
      return !q || [rule.name, rule.jiraProjectKey, pipelines.find((p) => p.id === rule.pipelineId)?.name ?? ''].some((x) => x.toLowerCase().includes(q))
    })
  const paused = watcher?.paused === true
  const nameOf = (id: string) => rules.find((r) => r.id === id)?.name ?? id

  // One line: where rules run now, plus the machine switch (disabled until there is a rule).
  let strip: string
  if (rules.length === 0) strip = 'Add a rule to start.'
  else if (role?.activeHere) strip = `Rules run on this machine (${role.thisMachineName})`
  else if (role?.other) strip = `Rules run on ${role.other.name} (last seen ${ago(role.other.heartbeatAt)})`
  else strip = "Rules aren't running on any machine"

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-8 py-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Automation</h1>
        <p className="text-sm text-muted-foreground">Rules start a pipeline when something happens in Jira.</p>
      </div>

      {paused && (
        <Notice ok={false}>All rules are paused: nothing is checked on any machine. Other machines pick this up with their next registry sync (up to a few minutes).</Notice>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3 text-sm" data-testid="status-strip">
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium text-foreground">{strip}</span>
          {role?.other?.stale && !role.activeHere && (
            <span className="text-xs text-warning">{role.other.name} has not reported since {when(role.other.heartbeatAt)}. If it is off, run the rules here instead.</span>
          )}
        </span>
        <span className="flex flex-wrap gap-2">
          {rules.length > 0 && (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => { const next = !paused; qc.setQueryData<WatcherInfo>(['watcher'], (old) => (old ? { ...old, paused: next } : old)); void run(() => window.axon.watcher.setPaused(next), next ? 'All rules paused' : 'Rules resumed') }}>
              {paused ? <><Play className="size-3.5" /> Resume all</> : <><Pause className="size-3.5" /> Pause all</>}
            </Button>
          )}
          {role?.activeHere
            ? <Button variant="outline" size="sm" disabled={busy} onClick={() => run(() => window.axon.watcher.setActiveHere(false), 'Rules no longer run on this machine')}>Stop running rules here</Button>
            : <Button size="sm" disabled={busy || rules.length === 0} onClick={() => run(() => window.axon.watcher.setActiveHere(true), 'Rules now run on this machine')}>Run rules on this machine</Button>}
        </span>
      </div>

      {(watcher?.pendingWritebacks ?? 0) > 0 && (
        <Notice ok={false}>
          <span className="flex flex-wrap items-center justify-between gap-2">
            <span>{watcher!.pendingWritebacks} write-back{watcher!.pendingWritebacks === 1 ? '' : 's'} waiting for Jira. They are retried until Jira accepts them.</span>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => window.axon.watcher.retryWritebacks(), 'Retried')}>Retry now</Button>
          </span>
        </Notice>
      )}

      {(watcher?.chains.warnings ?? []).map((w) => <Notice key={w} ok={false}>{w}</Notice>)}

      {(watcher?.orphans.length ?? 0) > 0 && (
        <SettingsCard
          title="Tickets that need your decision"
          description="These tickets are marked axon-running in Jira but have no delivery on this machine (started elsewhere, or interrupted before AXON could record it)."
        >
          {watcher!.orphans.map((o) => (
            <div key={o.key} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate"><strong>{o.key}</strong> {o.summary}</span>
              <span className="flex gap-2">
                <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => window.axon.watcher.resolveOrphan(o.key, 'release'), `${o.key} released`)}>Release</Button>
                <Button size="sm" disabled={busy} onClick={() => run(() => window.axon.watcher.resolveOrphan(o.key, 'resume'), `${o.key} started here`)}>Resume here</Button>
              </span>
            </div>
          ))}
        </SettingsCard>
      )}

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">Rules</h2>
        <Button size="sm" onClick={() => setEditing('new')}><Plus className="size-3.5" /> New rule</Button>
      </div>

      {rules.length === 0 && (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          <Radar className="size-6" />
          No rules yet. A rule pins a published pipeline version to a Jira project and a ready label.
        </div>
      )}

      {rules.length > 4 && (
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search rules by name, project or pipeline…" aria-label="Search rules" />
      )}

      <div className="flex flex-col gap-3" data-testid="rule-list">
        {visibleRules.map(({ rule, index }) => (
          <RuleRow
            key={rule.id}
            rule={rule}
            pipelineName={pipelines.find((p) => p.id === rule.pipelineId)?.name}
            latest={latestPublished(index)}
            status={watcher?.rules.find((r) => r.ruleId === rule.id)}
            chain={watcher?.chains.rules.find((r) => r.ruleId === rule.id)}
            effects={watcher?.chains.effects[rule.id]}
            deliveries={(byRule.get(rule.id) ?? []).map((d) => ({ id: d.id, ticketId: d.ticketId ?? '', status: d.status, startedAt: String(d.startedAt), localSeq: d.localSeq }))}
            paused={paused}
            activeHere={!!role?.activeHere}
            busy={busy}
            nameOf={nameOf}
            ago={ago}
            inMinutes={inMinutes}
            onToggle={(enabled) => run(() => window.axon.rules.setEnabled(rule.id, enabled), enabled ? 'Rule enabled' : 'Rule disabled')}
            onCheck={() => run(() => window.axon.watcher.checkNow(rule.id), 'Checked Jira')}
            onEdit={() => setEditing(rule)}
            onDelete={() => { if (window.confirm(`Delete rule "${rule.name}"?`)) void run(() => window.axon.rules.delete(rule.id), 'Rule deleted') }}
            onUpdateVersion={(version) => setUpdating({ rule, version })}
            onOpenDelivery={(id) => navigate(`/deliveries/${id}`)}
            onViewAll={() => navigate(`/deliveries?rule=${rule.id}`)}
            highlight={highlightId === rule.id}
            onOpenPipeline={() => navigate(`/pipelines/${rule.pipelineId}/edit?version=${rule.pipelineVersion}`)}
            jiraBase={jiraBase}
            onOpenJira={(url) => void window.axon.shell.openExternal(url)}
          />
        ))}
        {rules.length > 4 && visibleRules.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No rule matches “{query}”.</p>}
      </div>

      <UpdateVersionDialog
        rule={updating?.rule ?? null}
        toVersion={updating?.version ?? null}
        busy={busy}
        onClose={() => setUpdating(null)}
        onConfirm={async () => { if (updating) { await updateVersion(updating.rule, updating.version); setUpdating(null) } }}
      />

      <RuleDialog
        editing={editing}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); refresh() }}
      />
    </div>
  )
}

function RuleDialog({ editing, onClose, onSaved }: { editing: DeliveryRule | 'new' | null; onClose: () => void; onSaved: () => void }) {
  const { data: pipelines = [] } = usePipelines(undefined)
  const rule = editing && editing !== 'new' ? editing : null
  const [name, setName] = useState('')
  const [project, setProject] = useState('')
  const [mode, setMode] = useState<'label' | 'status'>('label')
  const [ready, setReady] = useState('axon-ready')
  const [pipelineId, setPipelineId] = useState('')
  const [version, setVersion] = useState<number | null>(null)
  const [workspace, setWorkspace] = useState('')
  const [interval, setIntervalMin] = useState(5)
  const [outcomeComment, setOutcomeComment] = useState(true)
  // Saving used to switch an edited rule off; now it keeps the state it had unless the engineer chooses otherwise.
  const [enableAfter, setEnableAfter] = useState(false)
  const [error, setError] = useState('')
  const [perm, setPerm] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  // A click outside an open dropdown must only close the dropdown, not the whole dialog.
  const selectClosedAt = useRef(0)
  const trackSelect = (open: boolean) => { if (!open) selectClosedAt.current = Date.now() }

  useEffect(() => {
    if (!editing) return
    setName(rule?.name ?? '')
    setProject(rule?.jiraProjectKey ?? '')
    setMode(rule?.readyStatus ? 'status' : 'label')
    setReady(rule?.readyStatus ?? rule?.readyLabel ?? 'axon-ready')
    setPipelineId(rule?.pipelineId ?? '')
    setVersion(rule?.pipelineVersion ?? null)
    setWorkspace(rule?.defaultWorkspacePath ?? '')
    setIntervalMin(rule?.pollIntervalMinutes ?? 5)
    setOutcomeComment(rule?.postOutcomeComment ?? true)
    setEnableAfter(rule?.enabled ?? false)
    setError('')
    setPerm(null)
  }, [editing, rule])

  const { data: versions = [] } = useQuery<VersionEntry[]>({
    queryKey: ['pipeline-versions', pipelineId],
    queryFn: () => window.axon.versions.list('pipeline', pipelineId),
    enabled: !!pipelineId,
    staleTime: 0,
    refetchOnMount: 'always',
  })
  const published = versions.filter((v) => v.status === 'Published').sort((a, b) => b.version - a.version)
  useEffect(() => {
    if (pipelineId && published.length && (version === null || !published.some((v) => v.version === version))) setVersion(published[0].version)
  }, [pipelineId, published, version])

  async function check() {
    if (!project) return
    setPerm(null)
    try {
      const r = await window.axon.jira.checkPermissions(project.toUpperCase())
      setPerm(r.ok ? [] : r.missing)
    } catch (e) {
      setPerm([cleanError(e)])
    }
  }

  async function save() {
    setBusy(true)
    setError('')
    try {
      await window.axon.rules.save({
        ...(rule ? { id: rule.id } : {}),
        name: name.trim(),
        jiraProjectKey: project.trim().toUpperCase(),
        ...(mode === 'status' ? { readyStatus: ready.trim(), readyLabel: 'axon-ready' } : { readyLabel: ready.trim() }),
        pipelineId,
        pipelineVersion: version,
        ...(workspace.trim() ? { defaultWorkspacePath: workspace.trim() } : {}),
        pollIntervalMinutes: interval,
        postOutcomeComment: outcomeComment,
        enabled: enableAfter,
      })
      toast.success(enableAfter ? 'Rule saved and enabled' : 'Rule saved (disabled). Enable it when you want it to start')
      onSaved()
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setBusy(false)
    }
  }

  async function pickFolder() {
    const dir = await window.axon.dialog.openDirectory(true)
    if (dir) setWorkspace(dir)
  }

  const valid = name.trim() && /^[A-Za-z][A-Za-z0-9_]+$/.test(project.trim()) && ready.trim() && pipelineId && version !== null && interval >= 2

  return (
    <Dialog open={!!editing} onOpenChange={(o) => { if (!o && Date.now() - selectClosedAt.current > 250) onClose() }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{rule ? 'Edit rule' : 'New rule'}</DialogTitle>
          <DialogDescription>A rule only decides when a pipeline starts. Saving it leaves it disabled; enabling it checks that your Jira account can read the project, edit labels and comment.</DialogDescription>
        </DialogHeader>
        <Field label="Name" htmlFor="rule-name"><Input id="rule-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Payments tickets" /></Field>
        <FieldRow>
          <Field label="Jira project key" htmlFor="rule-project">
            <Input id="rule-project" value={project} onChange={(e) => { setProject(e.target.value); setPerm(null) }} onBlur={check} placeholder="ABC" spellCheck={false} />
          </Field>
          <Field label="Ready signal">
            <Select onOpenChange={trackSelect} value={mode} onValueChange={(v) => { setMode(v as 'label' | 'status'); setReady(v === 'label' ? 'axon-ready' : '') }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="label">A label</SelectItem>
                <SelectItem value="status">A status</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </FieldRow>
        <Field label={mode === 'label' ? 'Ready label' : 'Ready status'} htmlFor="rule-ready" hint={mode === 'label' ? 'Re-adding this label to a finished ticket runs it again as a rerun.' : 'A ticket runs once each time it enters this status; tickets AXON is working on (axon-running) are skipped.'}>
          <Input id="rule-ready" value={ready} onChange={(e) => setReady(e.target.value)} spellCheck={false} />
        </Field>
        {perm && (perm.length === 0
          ? <Notice ok>Jira check passed for {project.toUpperCase()}: read, edit labels and comment.</Notice>
          : <Notice ok={false}>{perm.join(' ')}</Notice>)}
        <FieldRow>
          <Field label="Pipeline">
            <Select onOpenChange={trackSelect} value={pipelineId} onValueChange={(v) => { setPipelineId(v); setVersion(null) }}>
              <SelectTrigger><SelectValue placeholder="Choose a pipeline" /></SelectTrigger>
              <SelectContent>{pipelines.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Pinned version" hint={pipelineId && published.length === 0 ? 'Publish this pipeline first.' : undefined}>
            <Select onOpenChange={trackSelect} value={version === null ? '' : String(version)} onValueChange={(v) => setVersion(Number(v))} disabled={published.length === 0}>
              <SelectTrigger><SelectValue placeholder="Published versions" /></SelectTrigger>
              <SelectContent>{published.map((v) => <SelectItem key={v.version} value={String(v.version)}>v{v.version}{v.versionLabel ? ` · ${v.versionLabel}` : ''}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
        </FieldRow>
        <Field label="Default workspace path (optional)" hint="A clean git repo inside the Workspace Root; AXON branches it for each delivery.">
          <div className="flex gap-2">
            <Input value={workspace} onChange={(e) => setWorkspace(e.target.value)} placeholder="Leave empty to use the delivery folder" spellCheck={false} />
            <Button variant="outline" size="icon" onClick={pickFolder} aria-label="Choose folder"><FolderOpen /></Button>
          </div>
        </Field>
        <Field label="Check Jira every (minutes)" htmlFor="rule-interval" hint={interval < 2 ? "Must be at least 2 minutes." : "At least 2."}>
          <Input id="rule-interval" type="number" min={2} value={interval} onBlur={() => setIntervalMin((v) => Math.max(2, v))} aria-invalid={interval < 2} onChange={(e) => setIntervalMin(Math.max(0, Number(e.target.value) || 0))} />
        </Field>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox checked={outcomeComment} onCheckedChange={(v) => setOutcomeComment(v === true)} className="mt-0.5" />
          <span>
            <span className="font-medium text-foreground">Post AXON outcome comment</span>
            <span className="block text-xs text-muted-foreground">One comment in Jira when the delivery completes, fails or is cancelled, with links. Anything else that changes in Jira or GitHub is set by action blocks in the pipeline.</span>
          </span>
        </label>
        {error && <Notice ok={false}>{error}</Notice>}
        <DialogFooter className="items-center sm:justify-between">
          <label className="flex items-center gap-2 text-sm" title="Starts checking Jira as soon as the rule is saved. AXON first checks your Jira permissions and that the pinned pipeline can run without manual inputs. Off = save as a disabled draft.">
            <Switch checked={enableAfter} onCheckedChange={setEnableAfter} aria-label="Enable this rule after saving" />
            Enable
          </label>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={save} disabled={busy || !valid}>{busy ? 'Saving…' : 'Save'}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
