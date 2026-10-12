import { useState, useRef, useEffect } from 'react'
import { toast } from 'sonner'
import { createBlock, updateBlock } from '../../services/blocksService'
import { getBlockTypeIcon } from '../../utils/blockTypeIcons'
import { getRuntimeIcon, RUNTIME_LABELS } from '../../utils/runtimeIcons'
import ArtifactPopup from './ArtifactPopup'
import type { BuildingBlock, BlockType, SourceType, AgentRuntime, ArtifactFormat, ExecutionType, BuildingBlockVisibility } from '../../types'
import { AGENTIC_TOOL_OPTIONS } from '../../types'
import type { CachedFile } from '../../utils/fileHandler'

const BLOCK_TYPES: BlockType[] = ['Decision', 'Execution', 'Knowledge', 'Control', 'Utility', 'IO']
const SOURCE_TYPES: SourceType[] = ['Axon', 'Local', 'Marketplace', 'CDF']
// Only Claude and Codex are user-selectable; Axon is set by backend only
const RUNTIME_OPTIONS: AgentRuntime[] = ['Claude'] // Codex hidden in v1 (D4)
const EXECUTION_TYPES: ExecutionType[] = ['Prompt', 'Agentic']
const VISIBILITY_OPTIONS: BuildingBlockVisibility[] = ['Personal', 'Team', 'Organisation']

const AGREEMENT_CLAUSES: Record<(typeof AGENTIC_TOOL_OPTIONS)[number], string> = {
  Read: 'may read files in the repository',
  Glob: 'may search the repository file tree',
  Grep: 'may search file contents in the repository',
  Write: 'may create new files in the repository',
  Edit: 'may modify existing files in the repository',
  Bash: 'may execute shell commands in the workspace',
}

const CTX_CHIPS = [
  { key: 'ticket', desc: 'Jira ticket details' },
  { key: 'spec', desc: 'Generated specification' },
  { key: 'domainDocs', desc: 'MINERVA domain documents' },
  { key: 'repoStructure', desc: 'Repository file structure' },
  { key: 'repoPath', desc: 'Workspace repository path' },
  { key: 'changedFiles', desc: 'List of modified files' },
  { key: 'testResults', desc: 'Test run output' },
  { key: 'testConfig', desc: 'Test configuration' },
  { key: 'prUrl', desc: 'Created PR link' },
  { key: 'summary', desc: 'Running delivery summary' },
]

const OUT_CHIPS = [
  { key: 'score', desc: 'Numeric score (e.g. RRA score)' },
  { key: 'readinessLevel', desc: 'Ready / NeedsInfo / OutOfScope' },
  { key: 'missingFields', desc: 'List of missing items' },
  { key: 'changedFiles', desc: 'Files modified' },
  { key: 'testResults', desc: 'Test pass/fail breakdown' },
  { key: 'coverage', desc: 'Test coverage percentage' },
  { key: 'prUrl', desc: 'Created PR URL' },
  { key: 'prNumber', desc: 'PR number' },
  { key: 'decision', desc: 'Pass / Fail decision' },
  { key: 'summary', desc: 'Text summary' },
]

const inp: React.CSSProperties = {
  width: '100%',
  padding: '10px 10px',
  borderRadius: 6,
  fontSize: 13,
  background: 'var(--axon-bg4)',
  border: '1px solid var(--axon-border2)',
  color: 'var(--axon-t1)',
  outline: 'none',
  boxSizing: 'border-box',
  lineHeight: 1.6,
}


const lbl: React.CSSProperties = {
  fontSize: 11.5,
  color: 'var(--axon-t2)',
  marginBottom: 5,
  display: 'block',
  fontWeight: 500,
}

const secHdr: React.CSSProperties = {
  fontSize: 10.5,
  fontWeight: 700,
  color: 'var(--axon-t2)',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  marginBottom: 10,
}

const helper: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--axon-t2)',
  marginTop: 4,
  display: 'block',
  lineHeight: 1.5,
}

const divider: React.CSSProperties = {
  borderTop: '1px solid var(--axon-border)',
  margin: '14px 0',
}

function ChipPicker({
  predefined,
  selected,
  onToggle,
  customInput,
  onCustomChange,
  onAddCustom,
}: {
  predefined: { key: string; desc: string }[]
  selected: string[]
  onToggle: (k: string) => void
  customInput: string
  onCustomChange: (v: string) => void
  onAddCustom: () => void
}) {
  const extras = selected.filter((s) => !predefined.find((p) => p.key === s))
  const all = [...predefined, ...extras.map((e) => ({ key: e, desc: 'custom' }))]
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {all.map((c) => {
          const on = selected.includes(c.key)
          return (
            <button
              key={c.key}
              type="button"
              title={c.desc}
              onClick={() => onToggle(c.key)}
              style={{
                padding: '3px 9px',
                borderRadius: 12,
                fontSize: 11.5,
                cursor: 'pointer',
                border: `1px solid ${on ? '#22d3b8' : 'var(--axon-border2)'}`,
                background: on ? 'rgba(34,211,184,0.15)' : 'var(--axon-bg4)',
                color: on ? '#22d3b8' : 'var(--axon-t3)',
                fontWeight: on ? 600 : 400,
                transition: 'all 0.12s',
              }}
            >
              {c.key}
            </button>
          )
        })}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          style={{ ...inp, flex: 1 }}
          placeholder="Custom field…"
          value={customInput}
          onChange={(e) => onCustomChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              onAddCustom()
            }
          }}
        />
        <button
          type="button"
          onClick={onAddCustom}
          style={{
            padding: '7px 10px',
            borderRadius: 6,
            border: '1px solid var(--axon-border2)',
            background: 'var(--axon-bg4)',
            color: 'var(--axon-t2)',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          Add
        </button>
      </div>
    </div>
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
      ? {
          cachedFiles: cachedFileEntries(existingBlock.cachedFiles),
          entryPointPath: existingBlock.entryPointPath,
          artifactName: existingBlock.artifactName ?? '',
        }
      : null
  )
  // Tracks whether the artifact was actively re-attached during this edit session (real
  // content read from disk) vs just carried over for display from the existing block —
  // we must never PUT empty/placeholder content over a block's real cached files.
  const [artifactReattached, setArtifactReattached] = useState(false)
  const [tagInput, setTagInput] = useState('')
  const [tags, setTags] = useState<string[]>(existingBlock?.tags ?? [])
  const [ctxSelected, setCtxSelected] = useState<string[]>(existingBlock?.contextRequirements ?? [])
  const [ctxCustom, setCtxCustom] = useState('')
  const [outSelected, setOutSelected] = useState<string[]>(existingBlock?.outputSchema ?? [])
  const [outCustom, setOutCustom] = useState('')
  const [visibility, setVisibility] = useState<BuildingBlockVisibility>(existingBlock?.visibility ?? 'Personal')
  const [executionType, setExecutionType] = useState<ExecutionType>(existingBlock?.executionType ?? 'Prompt')
  const [allowedTools, setAllowedTools] = useState<string[]>(existingBlock?.allowedTools ?? [])
  const [defaultTimeoutSeconds, setDefaultTimeoutSeconds] = useState(existingBlock?.defaultTimeoutSeconds ?? 120)
  const [agreementAccepted, setAgreementAccepted] = useState(!!existingBlock?.executionAgreementAcceptedAt)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [showArtifactPopup, setShowArtifactPopup] = useState(false)
  const [nameFromSkill, setNameFromSkill] = useState(false)
  const [descriptionFromArtifact, setDescriptionFromArtifact] = useState(false)
  const [descriptionEditable, setDescriptionEditable] = useState(isEditing)

  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    nameRef.current?.focus()
  }, [])

  const addTag = () => {
    const v = tagInput.trim()
    if (v && !tags.includes(v)) setTags((t) => [...t, v])
    setTagInput('')
  }

  const toggleCtx = (k: string) => setCtxSelected((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]))
  const addCtxCustom = () => {
    const v = ctxCustom.trim()
    if (v && !ctxSelected.includes(v)) setCtxSelected((p) => [...p, v])
    setCtxCustom('')
  }
  const toggleOut = (k: string) => setOutSelected((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]))
  const addOutCustom = () => {
    const v = outCustom.trim()
    if (v && !outSelected.includes(v)) setOutSelected((p) => [...p, v])
    setOutCustom('')
  }

  const toggleTool = (tool: string) => {
    setAllowedTools((prev) => {
      const isOn = prev.includes(tool)
      // Edit/Write without Read access has no realistic path to succeed — don't allow that combination.
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

  const handleArtifactAttach = (data: { skillMeta?: { name?: string; description?: string }; cachedFiles: CachedFile[]; entryPointPath: string; artifactName: string }) => {
    setArtifactData(data)
    setArtifactReattached(true)
    setShowArtifactPopup(false)

    // Name: prefill only if empty (user-authored)
    if (data.skillMeta?.name && !name.trim()) {
      setName(data.skillMeta.name)
      setNameFromSkill(true)
    }

    // Description: always populate from artifact (artifact-owned), overwriting previous value
    if (data.skillMeta?.description) {
      setDescription(data.skillMeta.description)
      setDescriptionFromArtifact(true)
      setDescriptionEditable(true)
    } else {
      setDescription('')
      setDescriptionFromArtifact(false)
      setDescriptionEditable(true)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const errs: Record<string, string> = {}
    if (!name.trim()) errs.name = 'Name is required'
    if (!runtime) errs.runtime = 'Runtime is required'
    if (!sourceType) errs.sourceType = 'Source Type is required'
    if (sourceType === 'Local' && !artifactData) errs.artifact = 'Artifact is required for Local blocks'
    if (sourceType === 'Local' && executionType === 'Agentic') {
      if (allowedTools.length === 0) errs.allowedTools = 'Select at least one tool for an Agentic block'
      if (!agreementAccepted) errs.agreement = 'Execution agreement must be accepted'
    }
    if (sourceType === 'Marketplace' || sourceType === 'CDF') {
      errs.sourceType = 'Coming soon'
      setErrors(errs)
      return
    }
    if (Object.keys(errs).length) {
      setErrors(errs)
      return
    }
    setErrors({})
    setSubmitting(true)
    try {
      const isAgentic = sourceType === 'Local' && executionType === 'Agentic'
      // In edit mode, only send artifact fields if the author actively re-attached during
      // this session — sending the display-only placeholder would overwrite real cached
      // file content with blanks.
      const sendArtifact = !isEditing || artifactReattached
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
        contextRequirements: ctxSelected,
        outputSchema: outSelected,
        visibility: sourceType === 'Local' ? visibility : undefined,
        executionType: sourceType === 'Local' ? executionType : undefined,
        allowedTools: isAgentic ? allowedTools : undefined,
        defaultTimeoutSeconds,
        executionAgreementAccepted: isAgentic ? agreementAccepted : undefined,
      }
      const savedBlock = isEditing
        ? await updateBlock(existingBlock!.id, payload)
        : await createBlock(payload)
      toast.success(isEditing ? 'Block updated' : 'Block created')
      onCreated(savedBlock)
      onClose()
    } catch (err) {
      console.error('Block save error:', err)
      toast.error(isEditing ? 'Failed to update block' : 'Failed to create block')
    } finally {
      setSubmitting(false)
    }
  }

  const canCreate = !!(
    name.trim() &&
    role &&
    runtime &&
    sourceType &&
    (sourceType !== 'Local' || artifactData) &&
    sourceType !== 'Marketplace' &&
    sourceType !== 'CDF' &&
    (sourceType !== 'Local' || executionType !== 'Agentic' || (allowedTools.length > 0 && agreementAccepted))
  )

  const runtimeIsAxon = sourceType === 'Axon'

  return (
    <>
      <div
        style={{
          width: 420,
          flexShrink: 0,
          background: 'var(--axon-bg3)',
          border: '1px solid var(--axon-border)',
          borderRadius: 10,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '14px 16px 12px',
            borderBottom: '1px solid var(--axon-border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexShrink: 0,
          }}
        >
          <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--axon-t1)' }}>{isEditing ? 'Edit Block' : 'Create Block'}</span>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--axon-t3)',
              cursor: 'pointer',
              fontSize: 18,
              lineHeight: 1,
              padding: 2,
            }}
          >
            ×
          </button>
        </div>

        {/* Scrollable body */}
        <form onSubmit={handleSubmit} style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 0 }}>
          {/* ── Name & Description (no section header) ──────────────── */}
          <div style={{ marginBottom: 12 }}>
            <label style={lbl}>
              Name <span style={{ color: '#ef4444' }}>*</span>
            </label>
            <input
              ref={nameRef}
              style={{ ...inp, ...(errors.name ? { border: '1px solid #ef4444' } : {}) }}
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                if (nameFromSkill) setNameFromSkill(false)
              }}
              placeholder="e.g. ADC Integration Checker"
            />
            {errors.name && <span style={{ ...helper, color: '#ef4444' }}>{errors.name}</span>}
            {nameFromSkill && <span style={{ fontSize: 9, color: 'var(--axon-t4)', marginTop: 2, display: 'block' }}>from SKILL.md</span>}
          </div>

          <div style={divider} />

          {/* ── Role ─────────────────────────────────────────────────── */}
          <div style={{ marginBottom: 12 }}>
            <label style={lbl}>
              Role <span style={{ color: '#ef4444' }}>*</span>
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
              {BLOCK_TYPES.map((t) => {
                const roleIsReserved = t === 'Control'
                return (
                <button
                  key={t}
                  type="button"
                  onClick={() => setRole(t)}
                  disabled={roleIsReserved}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 8,
                    padding: 12,
                    borderRadius: 8,
                    border: role === t ? '2px solid var(--axon-nexus)' : '1px solid var(--axon-border)',
                    background: role === t ? 'rgba(111,95,232,0.15)' : 'var(--axon-bg4)',
                    cursor: roleIsReserved ? 'not-allowed' : 'pointer',
                    opacity: roleIsReserved ? 0.5 : 1,
                    transition: 'all 0.12s',
                  }}
                  title={roleIsReserved ? 'Reserved for Axon system blocks' : t}
                >
                  <img src={getBlockTypeIcon(t)} alt={t} style={{ width: 40, height: 40, borderRadius: 4 }} />
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: role === t ? 'var(--axon-nexus2)' : 'var(--axon-t3)',
                    }}
                  >
                    {t}
                  </span>
                </button>
                )
              })}
            </div>
          </div>

          {/* ── Runtime ──────────────────────────────────────────────── */}
          <div style={{ marginBottom: 12 }}>
            <label style={lbl}>
              Runtime <span style={{ color: '#ef4444' }}>*</span>
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
              {RUNTIME_OPTIONS.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRuntime(r)}
                  disabled={runtimeIsAxon}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 6,
                    padding: 10,
                    borderRadius: 8,
                    border: runtime === r ? '2px solid var(--axon-nexus)' : '1px solid var(--axon-border)',
                    background: runtime === r ? 'rgba(111,95,232,0.15)' : 'var(--axon-bg4)',
                    cursor: runtimeIsAxon ? 'not-allowed' : 'pointer',
                    transition: 'all 0.12s',
                    opacity: runtimeIsAxon ? 0.5 : 1,
                  }}
                  title={r === 'Codex' && sourceType === 'Local' ? 'Limited support' : undefined}
                >
                  <img
                    src={getRuntimeIcon(r)}
                    alt={r}
                    style={{ width: 28, height: 28, borderRadius: 4 }}
                  />
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      color: runtime === r ? 'var(--axon-nexus2)' : 'var(--axon-t3)',
                      textAlign: 'center',
                    }}
                  >
                    {RUNTIME_LABELS[r]}
                  </span>
                </button>
              ))}
            </div>
            {runtimeIsAxon && <span style={helper}>Fixed to Axon for system blocks</span>}
          </div>

          <div style={divider} />

          {/* ── Source Type ──────────────────────────────────────────── */}
          <div style={{ marginBottom: 12 }}>
            <label style={lbl}>
              Source Type <span style={{ color: '#ef4444' }}>*</span>
            </label>
            <select
              value={sourceType}
              disabled={isEditing}
              onChange={(e) => {
                const newSourceType = e.target.value as SourceType
                setSourceType(newSourceType)
                // Reset description when changing source type
                if (newSourceType !== 'Local') {
                  setDescription('')
                  setDescriptionEditable(false)
                  setDescriptionFromArtifact(false)
                  setArtifactData(null)
                  setExecutionType('Prompt')
                  setAllowedTools([])
                  setAgreementAccepted(false)
                }
              }}
              style={{ ...inp, ...(isEditing ? { opacity: 0.6, cursor: 'not-allowed' } : {}) }}
            >
              {SOURCE_TYPES.filter(s => s !== 'Axon').map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            {errors.sourceType && <span style={{ ...helper, color: '#ef4444' }}>{errors.sourceType}</span>}
            {isEditing && <span style={helper}>Source Type can't be changed after creation</span>}
          </div>

          {/* ── Artifact ──────────────────────────────────────────────── */}
          {sourceType === 'Local' && (
            <div style={{ marginBottom: 12 }}>
              <label style={lbl}>Artifact (Skill)</label>
              {artifactData ? (
                <div
                  style={{
                    padding: '10px 12px',
                    background: 'rgba(34,211,184,0.08)',
                    border: '1px solid rgba(34,211,184,0.2)',
                    borderRadius: 6,
                    fontSize: 12,
                    color: 'var(--axon-t1)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 500, marginBottom: 2 }}>{artifactData.artifactName}</div>
                    <div style={{ fontSize: 10, color: 'var(--axon-t3)' }}>
                      {artifactData.entryPointPath} + {artifactData.cachedFiles.length - 1} files
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowArtifactPopup(true)}
                    style={{
                      padding: '4px 8px',
                      borderRadius: 4,
                      border: '1px solid rgba(34,211,184,0.3)',
                      background: 'transparent',
                      color: 'var(--axon-teal)',
                      fontSize: 11,
                      cursor: 'pointer',
                    }}
                  >
                    Edit
                  </button>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setShowArtifactPopup(true)}
                    style={{
                      width: '100%',
                      padding: '10px 12px',
                      borderRadius: 6,
                      border: '1px solid var(--axon-border2)',
                      background: 'var(--axon-bg4)',
                      color: 'var(--axon-t1)',
                      fontSize: 13,
                      cursor: 'pointer',
                    }}
                  >
                    + Add Artifact
                  </button>
                  {errors.artifact && <span style={{ ...helper, color: '#ef4444' }}>{errors.artifact}</span>}
                </>
              )}
            </div>
          )}

          {(sourceType === 'Marketplace' || sourceType === 'CDF') && (
            <div style={{ marginBottom: 12, padding: '12px', borderRadius: 6, background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.2)' }}>
              <div style={{ fontSize: 12, color: 'var(--axon-amber)', fontWeight: 500 }}>Coming soon</div>
              <div style={{ fontSize: 11, color: 'var(--axon-t3)', marginTop: 4 }}>
                Browse and attach from {sourceType} coming in a future release
              </div>
            </div>
          )}

          {sourceType === 'Local' && (
            <>
              <div style={divider} />

              {/* ── Execution Profile ──────────────────────────────────── */}
              <div style={secHdr}>Execution Profile</div>
              <div style={{ marginBottom: 12 }}>
                <label style={lbl}>Visibility</label>
                <select value={visibility} onChange={(e) => setVisibility(e.target.value as BuildingBlockVisibility)} style={inp}>
                  {VISIBILITY_OPTIONS.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
                <span style={helper}>
                  {visibility === 'Personal'
                    ? 'Only you can see and run this block.'
                    : visibility === 'Team'
                      ? 'Visible to your team.'
                      : 'Visible to everyone in the organisation.'}
                </span>
              </div>

              <div style={{ marginBottom: 12 }}>
                <label style={lbl}>Execution Type</label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginBottom: 10 }}>
                  {EXECUTION_TYPES.map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => {
                        setExecutionType(t)
                        if (t === 'Prompt') {
                          setAllowedTools([])
                          setAgreementAccepted(false)
                        }
                      }}
                      style={{
                        padding: '8px 0',
                        borderRadius: 7,
                        border: executionType === t ? '2px solid var(--axon-nexus)' : '1px solid var(--axon-border)',
                        background: executionType === t ? 'rgba(111,95,232,0.15)' : 'var(--axon-bg4)',
                        color: executionType === t ? 'var(--axon-nexus2)' : 'var(--axon-t3)',
                        fontSize: 12.5,
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      {t}
                    </button>
                  ))}
                </div>
                <span style={helper}>
                  {executionType === 'Prompt'
                    ? 'A single text-only completion call — no file or system access.'
                    : 'Runs via the Claude Agent SDK with the tools selected below.'}
                </span>
              </div>

              {executionType === 'Agentic' && (
                <div style={{ marginBottom: 12 }}>
                  <label style={lbl}>
                    Allowed Tools <span style={{ color: '#ef4444' }}>*</span>
                  </label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {AGENTIC_TOOL_OPTIONS.map((tool) => {
                      const on = allowedTools.includes(tool)
                      const lockedOn = tool === 'Read' && (allowedTools.includes('Write') || allowedTools.includes('Edit'))
                      return (
                        <button
                          key={tool}
                          type="button"
                          onClick={() => toggleTool(tool)}
                          title={lockedOn ? 'Required because Write/Edit is selected' : undefined}
                          style={{
                            padding: '5px 11px',
                            borderRadius: 12,
                            fontSize: 12,
                            cursor: 'pointer',
                            border: `1px solid ${on ? '#22d3b8' : 'var(--axon-border2)'}`,
                            background: on ? 'rgba(34,211,184,0.15)' : 'var(--axon-bg4)',
                            color: on ? '#22d3b8' : 'var(--axon-t3)',
                            fontWeight: on ? 600 : 400,
                          }}
                        >
                          {tool}
                          {lockedOn ? ' 🔒' : ''}
                        </button>
                      )
                    })}
                  </div>
                  {errors.allowedTools && <span style={{ ...helper, color: '#ef4444' }}>{errors.allowedTools}</span>}
                </div>
              )}

              <div style={{ marginBottom: 12 }}>
                <label style={lbl}>Default Timeout (seconds)</label>
                <input
                  type="number"
                  min={1}
                  style={inp}
                  value={defaultTimeoutSeconds}
                  onChange={(e) => setDefaultTimeoutSeconds(Number(e.target.value) || 0)}
                />
                <span style={helper}>Prefills the node timeout when this block is dragged onto a pipeline canvas.</span>
              </div>

              {executionType === 'Agentic' && (
                <>
                  <div style={divider} />
                  <div style={secHdr}>Execution Agreement</div>
                  <div
                    style={{
                      marginBottom: 12,
                      padding: '10px 12px',
                      borderRadius: 6,
                      background: 'rgba(245,158,11,0.08)',
                      border: '1px solid rgba(245,158,11,0.2)',
                    }}
                  >
                    <div style={{ fontSize: 12, color: 'var(--axon-t1)', marginBottom: 6, fontWeight: 500 }}>
                      This block will run autonomously with the following capabilities:
                    </div>
                    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: 'var(--axon-t2)', lineHeight: 1.6 }}>
                      {allowedTools.length === 0 && <li>No tools selected yet</li>}
                      {allowedTools.map((tool) => (
                        <li key={tool}>{AGREEMENT_CLAUSES[tool as keyof typeof AGREEMENT_CLAUSES] ?? tool}</li>
                      ))}
                    </ul>
                    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 10, fontSize: 12, color: 'var(--axon-t1)', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={agreementAccepted}
                        onChange={(e) => setAgreementAccepted(e.target.checked)}
                        style={{ marginTop: 2 }}
                      />
                      I understand and accept that this block can act on the repository as described above.
                    </label>
                    {errors.agreement && <span style={{ ...helper, color: '#ef4444' }}>{errors.agreement}</span>}
                  </div>
                </>
              )}
            </>
          )}

          <div style={divider} />

          {/* ── Description (artifact-owned) ──────────────────────────── */}
          <div style={{ marginBottom: 12 }}>
            <label style={lbl}>Description</label>
            <textarea
              rows={3}
              disabled={!descriptionEditable}
              style={{
                ...inp,
                resize: 'vertical',
                opacity: descriptionEditable ? 1 : 0.6,
                cursor: descriptionEditable ? 'text' : 'not-allowed',
                backgroundColor: descriptionEditable ? 'var(--axon-bg4)' : 'var(--axon-bg5)',
              }}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={
                !artifactData
                  ? "Description loads from your skill's SKILL.md"
                  : descriptionFromArtifact
                    ? 'Extend or modify the description...'
                    : 'No description found in SKILL.md — add one here.'
              }
            />
            {descriptionFromArtifact && (
              <span style={{ fontSize: 9, color: 'rgba(34,211,184,0.7)', marginTop: 2, display: 'block' }}>
                ✓ from SKILL.md
              </span>
            )}
            {artifactData && !descriptionFromArtifact && description === '' && (
              <span style={{ fontSize: 9, color: 'var(--axon-t4)', marginTop: 2, display: 'block' }}>
                No description in artifact — you can add one
              </span>
            )}
          </div>

          <div style={divider} />

          {/* ── Context Requirements ──────────────────────────────────── */}
          <div style={secHdr}>Context Requirements</div>
          <span style={{ ...helper, marginTop: 0, marginBottom: 10, display: 'block' }}>
            What delivery context fields does this block need as input? AXON will inject only these fields — keeps token cost low.
          </span>
          <div style={{ marginBottom: 12 }}>
            <ChipPicker
              predefined={CTX_CHIPS}
              selected={ctxSelected}
              onToggle={toggleCtx}
              customInput={ctxCustom}
              onCustomChange={setCtxCustom}
              onAddCustom={addCtxCustom}
            />
          </div>

          <div style={divider} />

          {/* ── Output Schema ─────────────────────────────────────────── */}
          <div style={secHdr}>Output Schema</div>
          <span style={{ ...helper, marginTop: 0, marginBottom: 10, display: 'block' }}>
            What fields does this block return in its result? Used for branch conditions in Pipeline Creator.
          </span>
          <div style={{ marginBottom: 12 }}>
            <ChipPicker
              predefined={OUT_CHIPS}
              selected={outSelected}
              onToggle={toggleOut}
              customInput={outCustom}
              onCustomChange={setOutCustom}
              onAddCustom={addOutCustom}
            />
          </div>

          <div style={divider} />

          {/* ── Tags ──────────────────────────────────────────────────── */}
          <div style={{ marginBottom: 12 }}>
            <label style={lbl}>Tags</label>
            <div style={{ display: 'flex', gap: 6, marginBottom: 7 }}>
              <input
                style={{ ...inp, flex: 1 }}
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addTag()
                  }
                }}
                placeholder="e.g. assessment, quality"
              />
              <button
                type="button"
                onClick={addTag}
                style={{
                  padding: '7px 10px',
                  borderRadius: 6,
                  border: '1px solid var(--axon-border2)',
                  background: 'var(--axon-bg4)',
                  color: 'var(--axon-t2)',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                Add
              </button>
            </div>
            {tags.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {tags.map((t) => (
                  <span
                    key={t}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      fontSize: 11,
                      padding: '2px 8px',
                      borderRadius: 10,
                      background: 'var(--axon-bg5)',
                      color: 'var(--axon-t3)',
                      border: '1px solid var(--axon-border)',
                    }}
                  >
                    {t}
                    <button
                      type="button"
                      onClick={() => setTags((ts) => ts.filter((x) => x !== t))}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--axon-t3)',
                        cursor: 'pointer',
                        padding: 0,
                        fontSize: 12,
                        lineHeight: 1,
                      }}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </form>

        {/* Footer */}
        <div
          style={{
            padding: '12px 16px',
            borderTop: '1px solid var(--axon-border)',
            display: 'flex',
            gap: 8,
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              flex: 1,
              padding: '8px 0',
              borderRadius: 7,
              border: '1px solid var(--axon-border2)',
              background: 'none',
              color: 'var(--axon-t2)',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canCreate || submitting}
            onClick={handleSubmit}
            style={{
              flex: 2,
              padding: '8px 0',
              borderRadius: 7,
              border: 'none',
              background: canCreate && !submitting ? 'var(--axon-nexus)' : 'var(--axon-bg5)',
              color: canCreate && !submitting ? '#fff' : 'var(--axon-t3)',
              fontWeight: 600,
              fontSize: 13,
              cursor: canCreate && !submitting ? 'pointer' : 'default',
              transition: 'background 0.15s',
            }}
          >
            {submitting ? (isEditing ? 'Saving…' : 'Creating…') : isEditing ? 'Save Changes' : 'Create Block'}
          </button>
        </div>
      </div>

      {showArtifactPopup && <ArtifactPopup onAttach={handleArtifactAttach} onClose={() => setShowArtifactPopup(false)} />}
    </>
  )
}
