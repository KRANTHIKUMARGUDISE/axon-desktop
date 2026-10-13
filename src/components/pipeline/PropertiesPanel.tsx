import type { ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Repeat, X, XCircle } from 'lucide-react'
import type { OnFailureAction } from '@shared'
import type { BlockType } from '../../types'
import { getBlockTypeIcon } from '../../utils/blockTypeIcons'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Separator } from '../ui/separator'
import { Textarea } from '../ui/textarea'
import { ActionSettings, OnFailureSection, isActionArtifact } from './ActionPanels'

// The Pipeline Creator's right-hand panel. It always shows the pipeline's own settings (what happens when it fails, validation).
// Selecting a block on the canvas replaces that view with the block's settings; the X in the corner goes back to the pipeline.
// shadcn components + theme tokens only.

export interface PanelEdge { id: string; source: string; target: string; isDefault: boolean }

export interface PropertiesPanelProps {
  node: { id: string; data: Record<string, unknown> } | null
  /** The block's own name (a ForEach shows "ForEach"). */
  title: string
  /** The block's role (IO, Utility, Execution, ...). */
  role?: string
  description?: string
  /** Back to the pipeline view (deselects the node). */
  onClose: () => void
  /** What the selected block takes in and returns (from its definition). */
  inputs: { name: string; optional: boolean }[]
  inputsFromAll: boolean
  outputs: { name: string; type?: string; itemFields?: string[] }[]
  /** Number of nodes on the canvas (an empty pipeline has nothing to validate yet). */
  nodeCount: number
  /** An older version is shown: every control is disabled. */
  readOnly?: boolean
  isForEach: boolean
  isGate: boolean
  artifactName?: string
  forEachSource: string | null
  gate: { checklist: string[]; mode: 'Pause' | 'NotifyOnly' }
  onNodeData: (key: string, value: unknown) => void
  onConfig: (patch: Record<string, unknown>) => void
  onDeleteNode: () => void
  edges: PanelEdge[]
  onDefaultEdge: (edgeId: string) => void
  onFailure: OnFailureAction[]
  onFailureChange: (next: OnFailureAction[]) => void
  onFailureOnCancel: boolean
  onFailureOnCancelChange: (v: boolean) => void
  errors: string[]
  warnings: string[]
  outdatedPins: number
  onUpdatePins: () => void
}

function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

/** A titled group inside a tab, so sections are easy to tell apart. */
function Section({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border bg-background/30 p-3" data-testid={testId}>
      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h4>
      {children}
    </section>
  )
}

/** A collapsed group with a coloured edge and a count, so Context Requirements and Output Schema are easy to tell apart. */
function Expander({ title, accent, count, testId, children }: { title: string; accent: string; count?: number; testId?: string; children: ReactNode }) {
  return (
    <details className={`rounded-lg border border-l-4 px-3 py-2 ${accent}`} data-testid={testId}>
      <summary className="flex cursor-pointer items-center justify-between gap-2 text-sm font-medium text-foreground">
        <span>{title}</span>
        {count !== undefined && <Badge variant="secondary" className="h-5 min-w-5 px-1.5 text-[11px]">{count}</Badge>}
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  )
}

function Check({ label, pass }: { label: string; pass: boolean }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      {pass ? <CheckCircle2 className="size-4 shrink-0 text-success" /> : <XCircle className="size-4 shrink-0 text-destructive" />}
      <span className={pass ? 'text-foreground' : 'text-destructive'}>{label}</span>
    </div>
  )
}

// What a block needs from the block before it, so engineers know exactly what their agent must return.
const LIST_EXAMPLE = `{
  "workItems": {
    "items": [
      { "key": "api", "task": "Add the endpoint", "repo": "api" },
      { "key": "web", "task": "Show it in the UI", "repo": "web" }
    ],
    "shared": "optional notes every item can read"
  }
}`

function Contract({ children, example }: { children: ReactNode; example: string }) {
  return (
    <details className="rounded-lg border px-3 py-2" data-testid="input-contract">
      <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">Input this block expects</summary>
      <div className="mt-3 flex flex-col gap-3">
        <div className="flex flex-col gap-2 text-sm text-muted-foreground">{children}</div>
        <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-[11px] leading-relaxed text-foreground">{example}</pre>
        <p className="text-xs text-muted-foreground">
          The list field can have any name: declare it in the previous block's output schema with the type <span className="font-mono">WorkItemList</span>.
        </p>
      </div>
    </details>
  )
}

function ProvisionerContract() {
  return (
    <Contract example={LIST_EXAMPLE}>
      <p>The block directly before this one must return a work-item list. Every item needs:</p>
      <ul className="list-disc pl-5">
        <li><span className="font-mono text-foreground">key</span>: a unique id for the item</li>
        <li><span className="font-mono text-foreground">task</span>: what to do for it</li>
        <li><span className="font-mono text-foreground">repo</span>: the name of a repository in the catalog (Settings → Registry)</li>
      </ul>
      <p>It returns the same list with <span className="font-mono text-foreground">workspacePath</span> added to each item (the folder of that repository for this delivery).</p>
    </Contract>
  )
}

function ForEachContract() {
  return (
    <Contract example={LIST_EXAMPLE}>
      <p>Runs the blocks inside it once per item of the work-item list returned by the single block directly before it (usually Workspace Provisioner). Every item needs:</p>
      <ul className="list-disc pl-5">
        <li><span className="font-mono text-foreground">key</span>: a unique id for the item</li>
        <li><span className="font-mono text-foreground">task</span>: what to do for it</li>
      </ul>
      <p>Other fields stay on the item. Items run in list order. Blocks inside can use <span className="font-mono text-foreground">item</span>, <span className="font-mono text-foreground">itemKey</span>, <span className="font-mono text-foreground">task</span>, <span className="font-mono text-foreground">shared</span> and <span className="font-mono text-foreground">completedItems</span>.</p>
    </Contract>
  )
}

export default function PropertiesPanel(p: PropertiesPanelProps) {
  const n = p.node
  const d = (n?.data ?? {}) as Record<string, any>
  const config = (d.config ?? {}) as Record<string, unknown>
  const has = (s: string) => p.errors.some((e) => e.includes(s))
  const problems = p.errors.length


  return (
    <aside className="flex w-[340px] shrink-0 flex-col overflow-y-auto border-l bg-card p-4 text-card-foreground" data-testid="properties-panel">
      <fieldset disabled={p.readOnly} className="m-0 flex min-w-0 flex-col gap-5 border-0 p-0">
        {/* ------------------------------------------------ the selected block */}
        {n ? (
          <div className="flex flex-col gap-4">
              <div className="flex items-start gap-3">
                {p.isForEach
                  ? <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-muted"><Repeat className="size-5" /></span>
                  : p.role && <img src={getBlockTypeIcon(p.role as BlockType)} alt={p.role} className="size-10 shrink-0 rounded-lg" />}
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-base font-semibold text-foreground" title={p.title}>{p.title}</h3>
                  <Badge variant="outline" className="mt-1">{p.isForEach ? 'Flow' : (p.role ?? 'Block')}</Badge>
                </div>
                <Button variant="ghost" size="icon-sm" onClick={p.onClose} aria-label="Back to pipeline settings" title="Back to pipeline settings"><X /></Button>
              </div>

              {p.isForEach
                ? <p className="text-sm text-muted-foreground">Runs the blocks inside it once for every item of a work-item list.</p>
                : p.description && <p className="text-sm text-muted-foreground" data-testid="block-description">{p.description}</p>}

              {p.isForEach && (
                <Section title="Settings" testId="foreach-settings">
                  <p className="text-xs text-muted-foreground">
                    {p.forEachSource ? `Runs once per item from ${p.forEachSource}.` : 'Connect a block that returns a work-item list.'}
                  </p>
                  <Field label="Max items" hint="The run fails if the list is longer.">
                    <Input type="number" min={1} value={d.maxItems ?? 10} onChange={(e) => p.onNodeData('maxItems', Math.max(1, Number(e.target.value) || 1))} />
                  </Field>
                  <Field label="If the list is empty">
                    <Select value={d.onEmpty ?? 'fail'} onValueChange={(v) => p.onNodeData('onEmpty', v)}>
                      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent position="popper" side="bottom">
                        <SelectItem value="fail">Fail the run</SelectItem>
                        <SelectItem value="skip">Skip the ForEach</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                </Section>
              )}

              {p.isGate && (
                <Section title="Human review" testId="gate-settings">
                  <div className="flex flex-col gap-4" key={n.id}>
                    <Field label={<>Why a human decides here <span className="text-destructive">(required)</span></>} hint="Shown to the reviewer on the approval card.">
                      <Textarea
                        value={(config.reason as string | undefined) ?? ''}
                        onChange={(e) => p.onConfig({ reason: e.target.value })}
                        rows={3}
                        placeholder="e.g. Changes billing logic; a person must confirm the rules."
                      />
                    </Field>
                    <Field label="Review checklist (one per line, optional)" hint="Shown to the reviewer as a reminder of what to look at. It is not enforced: nothing has to be ticked to approve.">
                      <Textarea
                        defaultValue={p.gate.checklist.join('\n')}
                        onBlur={(e) => p.onConfig({ checklist: e.target.value.split('\n').map((l) => l.trim()).filter(Boolean) })}
                        rows={3}
                      />
                    </Field>
                    <Field
                      label="Mode"
                      hint={p.gate.mode === 'NotifyOnly'
                        ? 'The run keeps going and records that a review is due; review the pull request instead. Part of the published version.'
                        : 'The run stops here until someone approves or rejects it.'}
                    >
                      <Select value={p.gate.mode} onValueChange={(v) => p.onConfig({ mode: v })}>
                        <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent position="popper" side="bottom">
                          <SelectItem value="Pause">Pause for approval</SelectItem>
                          <SelectItem value="NotifyOnly">Notify only (do not pause)</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                </Section>
              )}

              {p.artifactName && isActionArtifact(p.artifactName) && (
                <Section title="Action settings">
                  <ActionSettings artifactName={p.artifactName} nodeKey={n.id} config={config} onChange={p.onConfig} />
                </Section>
              )}

              {p.edges.length > 1 && (
                <Section title="Which way next">
                  <p className="text-xs text-muted-foreground">This block has several outgoing connections. The default one is followed when no condition matches.</p>
                  {p.edges.map((e, i) => (
                    <label key={e.id} className="flex cursor-pointer items-center gap-2 text-sm">
                      <input type="radio" name={`default-${n.id}`} checked={e.isDefault} onChange={() => p.onDefaultEdge(e.id)} className="accent-primary" />
                      Connection {i + 1} is the default
                    </label>
                  ))}
                </Section>
              )}

              <Expander title="Context Requirements" accent="border-l-info" count={p.isForEach ? 1 : p.inputsFromAll ? undefined : p.inputs.length} testId="context-requirements">
                {p.isForEach
                  ? <p className="text-xs text-muted-foreground">{p.forEachSource ? `The work-item list returned by ${p.forEachSource}.` : 'A work-item list from the block before it.'}</p>
                  : p.inputsFromAll
                    ? <p className="text-xs text-muted-foreground">Full context: this block receives everything earlier steps returned.</p>
                    : p.inputs.length === 0
                      ? <p className="text-xs text-muted-foreground">None: nothing from earlier steps is passed to this block.</p>
                      : <ul className="flex flex-col gap-1 text-xs">{p.inputs.map((i) => <li key={i.name}><span className="font-mono text-foreground">{i.name}</span>{i.optional && <span className="text-muted-foreground"> (optional)</span>}</li>)}</ul>}
              </Expander>

              <Expander title="Output Schema" accent="border-l-success" count={p.isForEach ? 1 : p.outputs.length} testId="output-schema">
                {p.isForEach
                  ? <p className="text-xs text-muted-foreground"><span className="font-mono text-foreground">itemResults</span>: key, status, summary and result of every item.</p>
                  : p.outputs.length === 0
                    ? <p className="text-xs text-muted-foreground">No declared fields.</p>
                    : <ul className="flex flex-col gap-1 text-xs">{p.outputs.map((o) => <li key={o.name}><span className="font-mono text-foreground">{o.name}</span>{o.type && <span className="text-muted-foreground"> · {o.type}</span>}{o.type === 'WorkItemList' && <span className="block text-muted-foreground">Item fields: {o.itemFields?.length ? o.itemFields.join(', ') : 'none declared (only key, task, workspacePath)'}</span>}</li>)}</ul>}
              </Expander>

              {p.isForEach && <ForEachContract />}
              {p.artifactName === 'workspace-provisioner' && <ProvisionerContract />}

              {!p.isForEach && (
                <details className="rounded-lg border px-3 py-2" data-testid="advanced">
                  <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">Advanced</summary>
                  <div className="mt-3 flex flex-col gap-4">
                    <Field label="Step name" hint="Shown for this step on the canvas and in the Live View. Rename it when the same block appears twice, e.g. “Review backend”.">
                      <Input value={String(d.label ?? '')} onChange={(e) => p.onNodeData('label', e.target.value)} />
                    </Field>
                    <Field label="Timeout (seconds)" hint="The step fails if it runs longer than this.">
                      <Input type="number" value={d.timeoutSeconds ?? 120} onChange={(e) => p.onNodeData('timeoutSeconds', Number(e.target.value))} />
                    </Field>
                  </div>
                </details>
              )}

              <Separator />
              <Button variant="outline" size="sm" className="w-fit border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={p.onDeleteNode}>
                Remove from pipeline…
              </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div>
              <h3 className="text-base font-semibold text-foreground">Pipeline</h3>
              <p className="text-xs text-muted-foreground">Settings for the whole pipeline. Click a block on the canvas to edit that block.</p>
            </div>
          <Section title="When the pipeline fails" testId="on-failure-wrapper">
            <OnFailureSection actions={p.onFailure} onChange={p.onFailureChange} onCancel={p.onFailureOnCancel} onCancelChange={p.onFailureOnCancelChange} />
          </Section>

          <Section title="Validation" testId="validation">
            <div className="flex items-center justify-between gap-2">
              {p.nodeCount === 0
                ? <span className="text-xs text-muted-foreground">Nothing to check yet: drag a block onto the canvas to start.</span>
                : problems === 0
                ? <span className="flex items-center gap-1 text-xs text-success"><CheckCircle2 className="size-3.5" /> All checks passed</span>
                : <span className="flex items-center gap-1 text-xs text-destructive"><XCircle className="size-3.5" /> {problems} to fix</span>}
              {p.outdatedPins > 0 && (
                <Button variant="outline" size="sm" onClick={p.onUpdatePins} title="Pins stay as saved until you choose to update them">
                  Update block versions ({p.outdatedPins})
                </Button>
              )}
            </div>
            {p.errors.map((e, i) => (
              <div key={`e${i}`} className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs leading-relaxed text-destructive">
                <XCircle className="mt-0.5 size-3.5 shrink-0" /><span>{e}</span>
              </div>
            ))}
            {p.warnings.map((w, i) => (
              <div key={`w${i}`} className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs leading-relaxed text-warning">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /><span>{w}</span>
              </div>
            ))}
            {p.nodeCount > 0 && <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer hover:text-foreground">Checklist</summary>
              <div className="mt-2 flex flex-col gap-1.5">
                <Check label="Start node" pass={!has('start node')} />
                <Check label="Workspace before agents / PRs" pass={!has('Workspace Provisioner')} />
                <Check label="ForEach is well-formed" pass={!has('ForEach')} />
                <Check label="Branch nodes have default" pass={!has('default route')} />
              </div>
            </details>}
          </Section>
          </div>
        )}
      </fieldset>
    </aside>
  )
}

