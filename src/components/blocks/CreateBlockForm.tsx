import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { FileText, Lock, Plus, Trash2, X } from 'lucide-react'
import { createBlock, getBlocks, updateBlock } from '../../services/blocksService'
import { getBlockTypeIcon } from '../../utils/blockTypeIcons'
import { getRuntimeIcon, RUNTIME_LABELS } from '../../utils/runtimeIcons'
import ArtifactPopup from './ArtifactPopup'
import { ChipInput } from './ChipInput'
import type { BuildingBlock, BlockType, SourceType, AgentRuntime, ArtifactFormat, ExecutionType, BuildingBlockVisibility } from '../../types'
import { AGENTIC_TOOL_OPTIONS } from '../../types'
import type { CachedFile } from '../../utils/fileHandler'
import {
  AGENT_STANDARD_SHORT, decisionToolWarning, contextKey, contractSummary, contractToFields, entryFileContent, fieldsToContract, parseAxonContract,
} from '@shared'
import type { ContractOutput } from '@shared'
import { Alert, AlertDescription } from '../ui/alert'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Separator } from '../ui/separator'
import { Textarea } from '../ui/textarea'

// Create / Edit Block (View is BlockDetailPanel). The block's contract (what it needs and what it returns) is declared once, in
// the artifact's frontmatter (`axon:`, D19). When the artifact declares it the form only shows it; otherwise two small editors.

const BLOCK_TYPES: BlockType[] = ['Decision', 'Execution', 'Knowledge', 'Control', 'Utility', 'IO']
const VISIBILITY_OPTIONS: BuildingBlockVisibility[] = ['Personal', 'Team', 'Organisation']

const ROLE_HINT: Record<BlockType, string> = {
  Decision: 'Judges or classifies',
  Execution: 'Does the work (writes code, files)',
  Knowledge: 'Looks things up',
  Control: 'Reserved for AXON system blocks',
  Utility: 'Helper steps',
  IO: 'Reads from or writes to outside systems',
}

const AGREEMENT_CLAUSES: Record<(typeof AGENTIC_TOOL_OPTIONS)[number], string> = {
  Read: 'may read files in the repository',
  Glob: 'may search the repository file tree',
  Grep: 'may search file contents in the repository',
  Write: 'may create new files in the repository',
  Edit: 'may modify existing files in the repository',
  Bash: 'may execute shell commands in the workspace',
}

/** Fields AXON itself can hand to a block. `item.<field>` = a field every incoming work item must have. */
const AXON_PROVIDED = ['ticket', 'task', 'shared', 'item', 'item.repo', 'itemKey', 'completedItems', 'repoCatalog']

function Field({ label, required, hint, error, children }: { label: string; required?: boolean; hint?: ReactNode; error?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}{required && <span className="text-destructive"> *</span>}</Label>
      {children}
      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  )
}

interface CreateBlockFormProps {
  onClose: () => void
  onCreated: (block: BuildingBlock) => void
  existingBlock?: BuildingBlock
}

function cachedFileEntries(files: BuildingBlock['cachedFiles']): CachedFile[] {
  if (!files) return []
  return files.map((f) => (typeof f === 'string' ? { relativePath: f, content: '' } : f))
}

export default function CreateBlockForm({ onClose, onCreated, existingBlock }: CreateBlockFormProps) {
  const isEditing = !!existingBlock
  const [name, setName] = useState(existingBlock?.name ?? '')
  const [description, setDescription] = useState(existingBlock?.description ?? '')
  const [role, setRole] = useState<BlockType>(existingBlock?.role ?? 'Execution')
  const [runtime, setRuntime] = useState<AgentRuntime>(existingBlock?.agentRuntime ?? 'Claude')
  const [sourceType, setSourceType] = useState<SourceType>(existingBlock?.sourceType ?? 'Local')
  const [artifactData, setArtifactData] = useState<{ cachedFiles: CachedFile[]; entryPointPath: string; artifactName: string; skillMeta?: { name?: string; description?: string } } | null>(
    existingBlock?.entryPointPath
      ? { cachedFiles: cachedFileEntries(existingBlock.cachedFiles), entryPointPath: existingBlock.entryPointPath, artifactName: existingBlock.artifactName ?? '' }
      : null,
  )
  // Whether the artifact was actively re-attached in this session (real content) vs carried over for display: placeholder
  // content must never be sent over a block's real cached files.
  const [artifactReattached, setArtifactReattached] = useState(false)
  const [tags, setTags] = useState<string[]>(existingBlock?.tags ?? [])
  const [visibility, setVisibility] = useState<BuildingBlockVisibility>(existingBlock?.visibility ?? 'Personal')
  const [executionType, setExecutionType] = useState<ExecutionType>(existingBlock?.executionType ?? 'Prompt')
  const [allowedTools, setAllowedTools] = useState<string[]>(existingBlock?.allowedTools ?? [])
  const [defaultTimeoutSeconds, setDefaultTimeoutSeconds] = useState(existingBlock?.defaultTimeoutSeconds ?? 120)
  const [agreementAccepted, setAgreementAccepted] = useState(!!existingBlock?.executionAgreementAcceptedAt)
  const [contextMode, setContextMode] = useState<'Selective' | 'Full'>(existingBlock?.contextMode ?? 'Selective')
  const [catalogTags, setCatalogTags] = useState<string[]>(existingBlock?.catalogTags ?? [])

  // The contract as the form edits it when the artifact does not declare it.
  const initial = useMemo(
    () => fieldsToContract({ contextRequirements: existingBlock?.contextRequirements, outputSchema: existingBlock?.outputSchemaTyped, requiredItemFields: existingBlock?.requiredItemFields }),
    [existingBlock],
  )
  const [needs, setNeeds] = useState<string[]>(initial.inputs)
  const [returns, setReturns] = useState<ContractOutput[]>(initial.outputs)

  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [showArtifactPopup, setShowArtifactPopup] = useState(false)
  const [suggestions, setSuggestions] = useState<string[]>(AXON_PROVIDED)

  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => { nameRef.current?.focus() }, [])
  // Autocomplete: what AXON provides plus what other blocks return.
  useEffect(() => {
    getBlocks().then((all) => {
      const returned = all.flatMap((b) => b.outputSchema ?? [])
      setSuggestions([...new Set([...AXON_PROVIDED, ...returned])])
    }).catch(() => {})
  }, [])

  // Where the contract comes from: a freshly attached artifact, or the stored block's artifact when it is not re-attached.
  const freshContract = useMemo(() => (artifactReattached || !isEditing ? parseAxonContract(entryFileContent(artifactData ?? {}) ?? '') : null), [artifactData, artifactReattached, isEditing])
  const declaredByStoredArtifact = isEditing && !artifactReattached && existingBlock?.contractSource === 'artifact'
  const declared = freshContract?.declared ? freshContract : null
  const contractInvalid = !!declared && declared.errors.length > 0
  const fromArtifact = !!declared || declaredByStoredArtifact
  const shown = declared && !contractInvalid ? declared.contract : fromArtifact ? fieldsToContract({ contextRequirements: existingBlock?.contextRequirements, outputSchema: existingBlock?.outputSchemaTyped, requiredItemFields: existingBlock?.requiredItemFields }) : { inputs: needs, outputs: returns }
  const needsCatalog = shown.inputs.some((i) => contextKey(i) === 'repoCatalog')
  const contractFile = artifactData?.entryPointPath ?? existingBlock?.contractFile ?? 'SKILL.md'

  const handleArtifactAttach = (data: { skillMeta?: { name?: string; description?: string }; cachedFiles: CachedFile[]; entryPointPath: string; artifactName: string }) => {
    setArtifactData(data)
    setArtifactReattached(true)
    setShowArtifactPopup(false)
    if (data.skillMeta?.name && !name.trim()) setName(data.skillMeta.name)
    if (data.skillMeta?.description) setDescription(data.skillMeta.description)
  }

  const toggleTool = (tool: string) => {
    setAllowedTools((prev) => {
      const isOn = prev.includes(tool)
      // Edit/Write without Read access has no realistic path to succeed.
      if (isOn) {
        if (tool === 'Read' && (prev.includes('Write') || prev.includes('Edit'))) return prev
        return prev.filter((t) => t !== tool)
      }
      const next = [...prev, tool]
      if ((tool === 'Write' || tool === 'Edit') && !next.includes('Read')) next.push('Read')
      return next
    })
    setAgreementAccepted(false)
  }

  const updateRow = (i: number, patch: Partial<ContractOutput>) => setReturns((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const hasList = returns.some((r) => r.list)

  const isAgentic = sourceType === 'Local' && executionType === 'Agentic'
  const decisionWarning = decisionToolWarning(role, sourceType === 'Local' ? executionType : undefined, allowedTools)
  const canSave = !!(
    name.trim() && role && runtime && sourceType && (sourceType !== 'Local' || artifactData) && sourceType !== 'Marketplace' && sourceType !== 'CDF'
    && !contractInvalid && (!isAgentic || (allowedTools.length > 0 && agreementAccepted))
  )

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const errs: Record<string, string> = {}
    if (!name.trim()) errs.name = 'Name is required'
    if (sourceType === 'Local' && !artifactData) errs.artifact = 'An artifact is required for Local blocks'
    if (isAgentic) {
      if (allowedTools.length === 0) errs.allowedTools = 'Select at least one tool for an Agentic block'
      if (!agreementAccepted) errs.agreement = 'The execution agreement must be accepted'
    }
    if (sourceType === 'Marketplace' || sourceType === 'CDF') errs.sourceType = 'Coming soon'
    if (Object.keys(errs).length) { setErrors(errs); return }
    setErrors({})
    setSubmitting(true)
    try {
      const sendArtifact = !isEditing || artifactReattached
      // The artifact's declaration wins; the store re-derives it from the file as well.
      const fields = contractToFields(declared && !contractInvalid ? declared.contract : { inputs: needs, outputs: returns })
      const payload = {
        name: name.trim(),
        role,
        description: description.trim(),
        sourceType,
        agentRuntime: runtime,
        artifactFormat: 'Skill' as ArtifactFormat,
        artifactName: sendArtifact ? artifactData?.artifactName : undefined,
        cachedFiles: sendArtifact ? artifactData?.cachedFiles : undefined,
        entryPointPath: sendArtifact ? artifactData?.entryPointPath : undefined,
        tags,
        ...(declaredByStoredArtifact ? {} : { contextRequirements: fields.contextRequirements, outputSchema: fields.outputSchema, requiredItemFields: fields.requiredItemFields.length ? fields.requiredItemFields : undefined }),
        catalogTags: needsCatalog && catalogTags.length ? catalogTags : undefined,
        contextMode,
        visibility: sourceType === 'Local' ? visibility : undefined,
        executionType: sourceType === 'Local' ? executionType : undefined,
        allowedTools: isAgentic ? allowedTools : undefined,
        defaultTimeoutSeconds,
        executionAgreementAccepted: isAgentic ? agreementAccepted : undefined,
      }
      const saved = isEditing ? await updateBlock(existingBlock!.id, payload) : await createBlock(payload)
      toast.success(isEditing ? 'Block updated' : 'Block created')
      onCreated(saved)
      onClose()
    } catch (err) {
      console.error('Block save error:', err)
      toast.error(err instanceof Error && err.message ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : isEditing ? 'Failed to update block' : 'Failed to create block')
    } finally {
      setSubmitting(false)
    }
  }

  const summary = contractSummary(shown)

  return (
    <>
      <div className="flex w-[440px] shrink-0 flex-col overflow-hidden rounded-xl border bg-card text-card-foreground">
        <div className="flex shrink-0 items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-semibold">{isEditing ? 'Edit block' : 'Create block'}</h2>
          <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close"><X /></Button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-1 flex-col gap-6 overflow-y-auto p-4">
          {/* ------------------------------------------------ basics */}
          <Section title="Basics">
            <Field label="Name" required error={errors.name}>
              <Input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Demo Planner" aria-invalid={!!errors.name} />
            </Field>
            <Field label="Role" required hint={ROLE_HINT[role]}>
              <Select value={role} onValueChange={(v) => setRole(v as BlockType)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" side="bottom">
                  {BLOCK_TYPES.map((t) => (
                    <SelectItem key={t} value={t} disabled={t === 'Control'}>
                      <span className="flex items-center gap-2"><img src={getBlockTypeIcon(t)} alt="" className="size-5 rounded" />{t}{t === 'Control' && <Lock className="size-3 text-muted-foreground" />}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Description" hint={artifactData ? 'Taken from the artifact when it has one; you can edit it.' : 'Loads from your skill file when you add it.'}>
              <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What does this block do?" />
            </Field>
          </Section>

          <Separator />

          {/* ------------------------------------------------ artifact */}
          <Section title="Source">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Source" required error={errors.sourceType} hint={isEditing ? 'Cannot be changed after creation.' : undefined}>
                <Select value={sourceType} disabled={isEditing} onValueChange={(v) => {
                  setSourceType(v as SourceType)
                  if (v !== 'Local') { setDescription(''); setArtifactData(null); setExecutionType('Prompt'); setAllowedTools([]); setAgreementAccepted(false) }
                }}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent position="popper" side="bottom">
                    <SelectItem value="Local">Local</SelectItem>
                    <SelectItem value="Marketplace" disabled>Marketplace (soon)</SelectItem>
                    <SelectItem value="CDF" disabled>CDF (soon)</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Runtime" required>
                <Select value={runtime} onValueChange={(v) => setRuntime(v as AgentRuntime)}>
                  <SelectTrigger className="w-full">
                    <SelectValue>
                      <span className="flex items-center gap-2"><img src={getRuntimeIcon(runtime)} alt="" className="size-4 rounded" />{RUNTIME_LABELS[runtime]}</span>
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent position="popper" side="bottom">
                    <SelectItem value="Claude">Claude</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>

            {sourceType === 'Local' && (
              <Field label="Artifact (skill)" required error={errors.artifact}>
                <div className="flex items-center justify-between gap-3 rounded-lg border bg-background/40 p-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <FileText className="size-4 shrink-0 text-muted-foreground" />
                    {artifactData ? (
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{artifactData.artifactName}</p>
                        <p className="truncate text-xs text-muted-foreground">{artifactData.entryPointPath} · {Math.max(0, artifactData.cachedFiles.length - 1)} more files</p>
                      </div>
                    ) : <p className="text-sm text-muted-foreground">No artifact yet</p>}
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={() => setShowArtifactPopup(true)}>{artifactData ? 'Replace' : 'Add artifact'}</Button>
                </div>
              </Field>
            )}
            {(sourceType === 'Marketplace' || sourceType === 'CDF') && (
              <Alert><AlertDescription>Browsing and attaching from {sourceType} is coming in a future release.</AlertDescription></Alert>
            )}
            {sourceType === 'Local' && (
              <details className="rounded-lg border px-3 py-2 text-xs text-muted-foreground" data-testid="agent-standard">
                <summary className="cursor-pointer text-sm font-medium text-foreground">AXON Agent Standard</summary>
                <p className="mt-2 leading-relaxed">{AGENT_STANDARD_SHORT}</p>
              </details>
            )}
          </Section>

          <Separator />

          {/* ------------------------------------------------ contract */}
          <Section title="What it needs and returns" hint="The contract between this block and the blocks around it.">
            {contractInvalid && (
              <Alert variant="destructive" data-testid="contract-errors">
                <AlertDescription>
                  The `axon:` block in {contractFile} has problems, so the block cannot be saved yet:
                  <ul className="mt-1 list-disc pl-4">{declared!.errors.map((e) => <li key={e}>{e}</li>)}</ul>
                </AlertDescription>
              </Alert>
            )}

            {fromArtifact && !contractInvalid ? (
              <div className="flex flex-col gap-3 rounded-lg border bg-background/40 p-3 text-sm" data-testid="contract-readonly">
                <div className="flex items-center gap-2 text-xs text-muted-foreground"><Lock className="size-3.5" /> Defined in <span className="font-mono text-foreground">{contractFile}</span> (frontmatter, <span className="font-mono">axon:</span>)</div>
                <div><span className="font-medium">Needs: </span><span className="text-muted-foreground">{summary.needs}</span></div>
                <div><span className="font-medium">Returns: </span><span className="text-muted-foreground">{summary.returns}</span></div>
                <p className="text-xs text-muted-foreground">To change it, edit the frontmatter in the file and add the artifact again.</p>
              </div>
            ) : !contractInvalid && (
              <>
                <Field label="Needs" hint={<>Fields this block receives. <span className="font-mono">item.repo</span> = every incoming work item must have a <span className="font-mono">repo</span>; a trailing <span className="font-mono">?</span> makes a field optional.</>}>
                  <ChipInput
                    value={needs}
                    onChange={setNeeds}
                    suggestions={suggestions}
                    placeholder="Type a field and press Enter"
                    ariaLabel="Needs"
                    validate={(v) => (/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)?\??$/.test(v) && (!v.includes('.') || v.startsWith('item.')) ? null : 'Use letters and digits, or item.<field>')}
                  />
                </Field>

                <div className="flex flex-col gap-2">
                  <Label>Returns</Label>
                  {returns.length === 0 && <p className="text-xs text-muted-foreground">Nothing yet. List the fields the agent puts in its result.</p>}
                  {returns.map((r, i) => (
                    <div key={i} className="flex flex-col gap-2 rounded-lg border bg-background/40 p-2.5" data-testid="return-row">
                      <div className="flex items-center gap-2">
                        <Input value={r.name} onChange={(e) => updateRow(i, { name: e.target.value.replace(/\s+/g, '') })} placeholder="field name" className="font-mono text-xs" aria-label="Output field name" list="axon-return-suggestions" />
                        <Button type="button" variant="ghost" size="icon-sm" onClick={() => setReturns((rows) => rows.filter((_, j) => j !== i))} aria-label="Remove field"><Trash2 /></Button>
                      </div>
                      <label className={`flex items-center gap-2 text-xs ${!r.list && hasList ? 'opacity-50' : ''}`} title={!r.list && hasList ? 'A block can return only one work list' : undefined}>
                        <Checkbox
                          checked={!!r.list}
                          disabled={!r.list && hasList}
                          onCheckedChange={(v) => updateRow(i, v === true ? { list: true, kind: 'array', itemFields: r.itemFields ?? [] } : { list: false, kind: 'text', itemFields: undefined })}
                        />
                        Work list (feeds a ForEach)
                      </label>
                      {r.list && (
                        <div className="flex flex-col gap-1.5 border-l-2 border-primary/50 pl-3">
                          <span className="text-xs text-muted-foreground">Each item has <span className="font-mono">key</span> and <span className="font-mono">task</span>, and also:</span>
                          <ChipInput
                            value={r.itemFields ?? []}
                            onChange={(v) => updateRow(i, { itemFields: v })}
                            placeholder="e.g. repo"
                            ariaLabel="Item fields"
                            validate={(v) => (/^[A-Za-z][A-Za-z0-9_]*$/.test(v) ? null : 'Letters and digits only')}
                          />
                        </div>
                      )}
                    </div>
                  ))}
                  <datalist id="axon-return-suggestions">{suggestions.filter((s) => !s.includes('.')).map((s) => <option key={s} value={s} />)}</datalist>
                  <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => setReturns((rows) => [...rows, { name: '', kind: 'text' }])}><Plus /> Add field</Button>
                </div>
              </>
            )}

            {needsCatalog && (
              <Field label="Catalog tags (optional)" hint="Only repositories with one of these tags are shown to the agent. Empty = the whole catalog.">
                <ChipInput value={catalogTags} onChange={setCatalogTags} placeholder="e.g. backend" ariaLabel="Catalog tags" />
              </Field>
            )}
          </Section>

          {/* ------------------------------------------------ execution */}
          {sourceType === 'Local' && (
            <>
              <Separator />
              <Section title="How it runs">
                <Field label="Execution type" hint={executionType === 'Prompt' ? 'One text-only call to Claude: no file or system access.' : 'Runs through the Claude Agent SDK with the tools you allow below.'}>
                  <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Execution type">
                    {(['Prompt', 'Agentic'] as ExecutionType[]).map((t) => (
                      <Button
                        key={t}
                        type="button"
                        role="radio"
                        aria-checked={executionType === t}
                        variant={executionType === t ? 'default' : 'outline'}
                        onClick={() => { setExecutionType(t); if (t === 'Prompt') { setAllowedTools([]); setAgreementAccepted(false) } }}
                      >
                        {t}
                      </Button>
                    ))}
                  </div>
                </Field>

                {executionType === 'Agentic' && (
                  <>
                    <Field label="Allowed tools" required error={errors.allowedTools}>
                      <div className="flex flex-wrap gap-1.5">
                        {AGENTIC_TOOL_OPTIONS.map((tool) => {
                          const on = allowedTools.includes(tool)
                          const lockedOn = tool === 'Read' && (allowedTools.includes('Write') || allowedTools.includes('Edit'))
                          return (
                            <Button key={tool} type="button" size="sm" variant={on ? 'default' : 'outline'} onClick={() => toggleTool(tool)} title={lockedOn ? 'Required because Write or Edit is selected' : undefined}>
                              {tool}{lockedOn && <Lock className="size-3" />}
                            </Button>
                          )
                        })}
                      </div>
                    </Field>
                    {decisionWarning && <Alert data-testid="decision-tools-warning"><AlertDescription>{decisionWarning}</AlertDescription></Alert>}
                    <div className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3">
                      <p className="text-sm font-medium">This block runs on its own and:</p>
                      <ul className="list-disc pl-5 text-xs text-muted-foreground">
                        {allowedTools.length === 0 && <li>has no tools selected yet</li>}
                        {allowedTools.map((tool) => <li key={tool}>{AGREEMENT_CLAUSES[tool as keyof typeof AGREEMENT_CLAUSES] ?? tool}</li>)}
                      </ul>
                      <label className="flex items-start gap-2 text-xs">
                        <Checkbox checked={agreementAccepted} onCheckedChange={(v) => setAgreementAccepted(v === true)} className="mt-0.5" />
                        I understand and accept that this block can act on the repository as described.
                      </label>
                      {errors.agreement && <p className="text-xs text-destructive">{errors.agreement}</p>}
                    </div>
                  </>
                )}
              </Section>
            </>
          )}

          {/* ------------------------------------------------ advanced */}
          <details className="rounded-lg border px-3 py-2" data-testid="advanced">
            <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">Advanced</summary>
            <div className="mt-3 flex flex-col gap-4">
              {sourceType === 'Local' && (
                <Field label="Visibility" hint={visibility === 'Personal' ? 'Only you can see and run this block.' : visibility === 'Team' ? 'Visible to your team.' : 'Visible to everyone in the organisation.'}>
                  <Select value={visibility} onValueChange={(v) => setVisibility(v as BuildingBlockVisibility)}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent position="popper" side="bottom">{VISIBILITY_OPTIONS.map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}</SelectContent>
                  </Select>
                </Field>
              )}
              <Field label="Default timeout (seconds)" hint="Prefills the node timeout when the block is added to a pipeline.">
                <Input type="number" min={1} value={defaultTimeoutSeconds} onChange={(e) => setDefaultTimeoutSeconds(Number(e.target.value) || 0)} />
              </Field>
              <label className="flex items-start gap-2 text-sm">
                <Checkbox checked={contextMode === 'Full'} onCheckedChange={(v) => setContextMode(v === true ? 'Full' : 'Selective')} className="mt-0.5" />
                <span>
                  Send the whole context
                  <span className="block text-xs text-muted-foreground">Off by default: the block only receives the fields listed under Needs. Turning this on costs more tokens.</span>
                </span>
              </label>
              <Field label="Tags">
                <ChipInput value={tags} onChange={setTags} placeholder="e.g. assessment" ariaLabel="Tags" />
              </Field>
            </div>
          </details>
        </form>

        <div className="flex shrink-0 gap-2 border-t p-3">
          <Button type="button" variant="outline" className="flex-1" onClick={onClose}>Cancel</Button>
          <Button type="submit" className="flex-[2]" disabled={!canSave || submitting} onClick={handleSubmit}>
            {submitting ? (isEditing ? 'Saving…' : 'Creating…') : isEditing ? 'Save changes' : 'Create block'}
          </Button>
        </div>
      </div>

      {showArtifactPopup && <ArtifactPopup onAttach={handleArtifactAttach} onClose={() => setShowArtifactPopup(false)} />}
    </>
  )
}
