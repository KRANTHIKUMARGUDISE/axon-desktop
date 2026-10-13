import type { ReactNode } from 'react'
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react'
import {
  JIRA_UPDATE_ARTIFACT, PR_UPDATE_ARTIFACT, FIND_PRS_ARTIFACT, TEMPLATE_HINT,
  readJiraUpdateConfig, readPrUpdateConfig,
} from '@shared'
import type { OnFailureAction } from '@shared'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Textarea } from '../ui/textarea'

// S5b: settings for the action blocks (Jira Update, PR Update, Find PRs) and the pipeline's "On failure" section.
// Built from the shared shadcn components so they look and behave like the rest of the app.

const list = (v: string) => v.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)

export const isActionArtifact = (artifactName: string | undefined) =>
  artifactName === JIRA_UPDATE_ARTIFACT || artifactName === PR_UPDATE_ARTIFACT || artifactName === FIND_PRS_ARTIFACT

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

/** One item per line (or comma separated); committed when the field loses focus. */
function ListField({ label, value, onCommit, placeholder, rows = 2 }: { label: string; value: string[]; onCommit: (v: string[]) => void; placeholder?: string; rows?: number }) {
  return (
    <Field label={label}>
      <Textarea defaultValue={value.join('\n')} onBlur={(e) => onCommit(list(e.target.value))} rows={rows} placeholder={placeholder} />
    </Field>
  )
}

function CommentField({ value, onCommit, placeholder, rows = 4 }: { value?: string; onCommit: (v: string | undefined) => void; placeholder: string; rows?: number }) {
  return (
    <Field label="Comment (optional)">
      <Textarea defaultValue={value ?? ''} onBlur={(e) => onCommit(e.target.value.trim() ? e.target.value : undefined)} rows={rows} placeholder={placeholder} />
    </Field>
  )
}

interface PanelProps {
  /** Re-mounts the uncontrolled fields when another node is selected. */
  nodeKey: string
  config: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
}

export function ActionSettings({ artifactName, ...p }: PanelProps & { artifactName: string }) {
  if (artifactName === JIRA_UPDATE_ARTIFACT) return <JiraUpdatePanel {...p} />
  if (artifactName === PR_UPDATE_ARTIFACT) return <PrUpdatePanel {...p} />
  return (
    <p className="text-xs text-muted-foreground" data-testid="find-prs-settings">
      Finds the open pull requests in your catalog repositories whose branch contains the ticket key and returns them as a work list
      (repo, branch, prUrl). Connect Workspace Provisioner after it to check the branch out. Needs your GitHub token.
    </p>
  )
}

function JiraUpdatePanel({ nodeKey, config, onChange }: PanelProps) {
  const cfg = readJiraUpdateConfig(config)
  return (
    <div className="flex flex-col gap-4" data-testid="jira-update-settings" key={nodeKey}>
      <Field label="Move ticket to status">
        <Input defaultValue={cfg.transition ?? ''} onBlur={(e) => onChange({ transition: e.target.value.trim() || undefined })} placeholder="e.g. In Review" />
      </Field>
      <ListField label="Add labels (one per line)" value={cfg.addLabels} onCommit={(v) => onChange({ addLabels: v })} placeholder="spec-ready" />
      <ListField label="Remove labels" value={cfg.removeLabels} onCommit={(v) => onChange({ removeLabels: v })} />
      <Field label="Assign to" hint="“Whoever runs the delivery” is the engineer whose AXON runs this pipeline (their Jira account), not the person who created the pipeline.">
        <Select value={cfg.assign ?? 'none'} onValueChange={(v) => onChange({ assign: v === 'none' ? undefined : v })}>
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent position="popper" side="bottom">
            <SelectItem value="none">Leave as is</SelectItem>
            <SelectItem value="user">Whoever runs the delivery</SelectItem>
            <SelectItem value="reporter">The ticket reporter</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <CommentField value={cfg.comment} onCommit={(v) => onChange({ comment: v })} placeholder="{{output.spec}}" />
      <p className="text-xs text-muted-foreground">
        Fields: <span className="font-mono">{TEMPLATE_HINT}</span>. Long comments are attached as a file. Nothing is applied twice on a resume or rerun.
      </p>
    </div>
  )
}

function PrUpdatePanel({ nodeKey, config, onChange }: PanelProps) {
  const cfg = readPrUpdateConfig(config)
  return (
    <div className="flex flex-col gap-4" data-testid="pr-update-settings" key={nodeKey}>
      <ListField label="Add labels (one per line)" value={cfg.addLabels} onCommit={(v) => onChange({ addLabels: v })} placeholder="ready-for-review" />
      <ListField label="Request reviewers (GitHub logins)" value={cfg.reviewers} onCommit={(v) => onChange({ reviewers: v })} />
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={cfg.readyForReview} onCheckedChange={(v) => onChange({ readyForReview: v === true })} />
        Mark draft PRs ready for review
      </label>
      <CommentField value={cfg.comment} onCommit={(v) => onChange({ comment: v })} placeholder="Reviewed by AXON for {{ticketKey}}" />
      <p className="text-xs text-muted-foreground">
        Acts on the pull requests from PR Creator or Find PRs. Fields: <span className="font-mono">{TEMPLATE_HINT}</span>.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------- On failure (pipeline setting)

function move<T>(arr: T[], i: number, by: -1 | 1): T[] {
  const next = [...arr]
  const j = i + by
  if (j < 0 || j >= next.length) return arr
  ;[next[i], next[j]] = [next[j], next[i]]
  return next
}

export function OnFailureSection({ actions, onChange, onCancel, onCancelChange }: {
  actions: OnFailureAction[]
  onChange: (next: OnFailureAction[]) => void
  onCancel: boolean
  onCancelChange: (v: boolean) => void
}) {
  const set = (i: number, patch: Record<string, unknown>) => onChange(actions.map((a, j) => (j === i ? ({ ...a, ...patch } as OnFailureAction) : a)))
  return (
    <div className="flex flex-col gap-3" data-testid="on-failure-section">
      <p className="text-xs text-muted-foreground">
        If any step of this pipeline fails (a rejected Human Gate counts), these actions run once, in order, after the failure is recorded.
        They don't change the delivery's status. They are not part of any single block.
      </p>

      {actions.map((a, i) => (
        <div key={i} className="flex flex-col gap-3 rounded-md border bg-background/40 p-3" data-testid="on-failure-action">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">{i + 1}. {a.kind === 'jira-update' ? 'Jira Update' : 'PR Update'}</span>
            <span className="flex gap-1">
              <Button variant="ghost" size="icon-sm" disabled={i === 0} onClick={() => onChange(move(actions, i, -1))} aria-label="Move up"><ArrowUp /></Button>
              <Button variant="ghost" size="icon-sm" disabled={i === actions.length - 1} onClick={() => onChange(move(actions, i, 1))} aria-label="Move down"><ArrowDown /></Button>
              <Button variant="ghost" size="icon-sm" onClick={() => onChange(actions.filter((_, j) => j !== i))} aria-label="Remove"><X /></Button>
            </span>
          </div>
          {a.kind === 'jira-update' ? (
            <>
              <Field label="Move ticket to status">
                <Input defaultValue={a.transition ?? ''} onBlur={(e) => set(i, { transition: e.target.value.trim() || undefined })} />
              </Field>
              <ListField label="Add labels" value={a.addLabels} onCommit={(v) => set(i, { addLabels: v })} placeholder="code-failed" />
              <ListField label="Remove labels" value={a.removeLabels} onCommit={(v) => set(i, { removeLabels: v })} />
              <CommentField value={a.comment} onCommit={(v) => set(i, { comment: v })} placeholder="AXON failed: {{failureReason}}" rows={3} />
            </>
          ) : (
            <>
              <ListField label="Add labels" value={a.addLabels} onCommit={(v) => set(i, { addLabels: v })} placeholder="axon-failed" />
              <CommentField value={a.comment} onCommit={(v) => set(i, { comment: v })} placeholder="{{failureReason}}" rows={3} />
            </>
          )}
        </div>
      ))}

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => onChange([...actions, { kind: 'jira-update', addLabels: [], removeLabels: [] }])}><Plus /> Jira Update</Button>
        <Button variant="outline" size="sm" onClick={() => onChange([...actions, { kind: 'pr-update', addLabels: [], reviewers: [], readyForReview: false }])}><Plus /> PR Update</Button>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <Checkbox checked={onCancel} onCheckedChange={(v) => onCancelChange(v === true)} className="mt-0.5" />
        Also run when the delivery is cancelled
      </label>
      {actions.length > 0 && (
        <p className="text-xs text-muted-foreground">Fields: <span className="font-mono">{'{{failureReason}} {{ticketKey}} {{prUrls}} {{deliveryLink}}'}</span></p>
      )}
    </div>
  )
}
