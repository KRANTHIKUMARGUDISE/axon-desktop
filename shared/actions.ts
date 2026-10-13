import { z } from 'zod'

// S5b: configuration of the native action blocks (Jira Update, PR Update, Find PRs). Like the Human Gate
// they keep their settings in PipelineNode.config, so they are pinned with the published pipeline version.

export const JIRA_UPDATE_ARTIFACT = 'jira-update'
export const PR_UPDATE_ARTIFACT = 'pr-update'
export const FIND_PRS_ARTIFACT = 'find-prs'
export const TICKET_FETCHER_ARTIFACT = 'ticket-fetcher'
export const ACTION_ARTIFACTS: readonly string[] = [JIRA_UPDATE_ARTIFACT, PR_UPDATE_ARTIFACT, FIND_PRS_ARTIFACT]

const Label = z.string().trim().min(1).max(255).regex(/^[^\s]+$/, 'labels cannot contain spaces')

/** assign: 'user' = the engineer running AXON, 'reporter' = the ticket reporter, 'field:<name>' = a user field. */
export const AssignSchema = z.string().trim().max(120).refine((v) => v === 'user' || v === 'reporter' || /^field:[A-Za-z0-9_ ]+$/.test(v), 'user | reporter | field:<name>')

export const JiraUpdateConfigSchema = z.object({
  transition: z.string().trim().max(100).optional(),
  addLabels: z.array(Label).max(20).default([]),
  removeLabels: z.array(Label).max(20).default([]),
  assign: AssignSchema.optional(),
  comment: z.string().max(20000).optional(),
})
export type JiraUpdateConfig = z.infer<typeof JiraUpdateConfigSchema>

export const PrUpdateConfigSchema = z.object({
  addLabels: z.array(Label).max(20).default([]),
  reviewers: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  readyForReview: z.boolean().default(false),
  comment: z.string().max(20000).optional(),
})
export type PrUpdateConfig = z.infer<typeof PrUpdateConfigSchema>

/** An "On failure" (pipeline setting) entry: one action config plus which block it runs as. */
export const OnFailureActionSchema = z.discriminatedUnion('kind', [
  JiraUpdateConfigSchema.extend({ kind: z.literal('jira-update') }),
  PrUpdateConfigSchema.extend({ kind: z.literal('pr-update') }),
])
export type OnFailureAction = z.infer<typeof OnFailureActionSchema>

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean) : []
}
function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

/** Lenient read used at run time and in the UI: missing pieces become empty/default. */
export function readJiraUpdateConfig(config: Record<string, unknown> | undefined): JiraUpdateConfig {
  return {
    transition: optStr(config?.transition),
    addLabels: strList(config?.addLabels),
    removeLabels: strList(config?.removeLabels),
    assign: optStr(config?.assign),
    comment: typeof config?.comment === 'string' && config.comment.trim() ? config.comment : undefined,
  }
}
export function readPrUpdateConfig(config: Record<string, unknown> | undefined): PrUpdateConfig {
  return {
    addLabels: strList(config?.addLabels),
    reviewers: strList(config?.reviewers),
    readyForReview: config?.readyForReview === true,
    comment: typeof config?.comment === 'string' && config.comment.trim() ? config.comment : undefined,
  }
}
export function readOnFailure(raw: unknown): OnFailureAction[] {
  if (!Array.isArray(raw)) return []
  const out: OnFailureAction[] = []
  for (const r of raw) {
    const p = OnFailureActionSchema.safeParse(r)
    if (p.success) out.push(p.data)
  }
  return out
}

// ---------------------------------------------------------------- templates

export const TEMPLATE_VARS = ['prUrls', 'deliveryLink', 'failureReason', 'ticketKey'] as const
export const TEMPLATE_HINT = '{{output.<field>}} {{prUrls}} {{deliveryLink}} {{failureReason}} {{ticketKey}}'

const TOKEN = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g

export interface TemplateRefs {
  /** `{{output.x}}` field names. */
  outputs: string[]
  /** Unknown tokens (neither output.* nor a known variable). */
  unknown: string[]
}

export function templateRefs(template: string | undefined): TemplateRefs {
  const refs: TemplateRefs = { outputs: [], unknown: [] }
  if (!template) return refs
  for (const m of template.matchAll(TOKEN)) {
    const tok = m[1]
    if (tok.startsWith('output.') && tok.length > 7) refs.outputs.push(tok.slice(7).split('.')[0])
    else if (!(TEMPLATE_VARS as readonly string[]).includes(tok)) refs.unknown.push(tok)
  }
  return refs
}

export interface TemplateData {
  /** Merged results of upstream steps (the flat context pool). */
  output: Record<string, unknown>
  prUrls: string[]
  deliveryLink: string
  failureReason: string
  ticketKey: string
}

function show(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.join('\n')
  try { return JSON.stringify(v, null, 2) } catch { return String(v) }
}

/** Replace `{{…}}` tokens. Unknown tokens render empty (the validator flags them before a run). */
export function renderTemplate(template: string, data: TemplateData): string {
  return template.replace(TOKEN, (_m, tok: string) => {
    if (tok.startsWith('output.')) {
      let cur: unknown = data.output
      for (const part of tok.slice(7).split('.')) {
        if (cur && typeof cur === 'object') cur = (cur as Record<string, unknown>)[part]
        else return ''
      }
      return show(cur)
    }
    switch (tok) {
      case 'prUrls': return data.prUrls.join('\n')
      case 'deliveryLink': return data.deliveryLink
      case 'failureReason': return data.failureReason
      case 'ticketKey': return data.ticketKey
      default: return ''
    }
  })
}

/** Comments above this size are attached as a file and the comment links to it (Jira caps comments at ~32 KB). */
export const COMMENT_ATTACH_THRESHOLD = 20000
