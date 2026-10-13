import type { FailureCategory } from './schemas'

// S5 Part C (maturity Q9): every failed delivery is Requirement | Agent | Platform.
//  Requirement — a readiness/requirement block failed, or the output declared the requirement unclear.
//  Agent       — an agent step failed, produced invalid output, or the output was rejected at a gate.
//  Platform    — AXON/infrastructure error (git, network, crash).

export interface FailureInput {
  /** The step threw (runner crash, workspace/git/cwd/store error) rather than returning a failed output. */
  thrown?: boolean
  errorCode?: string
  message?: string
  /** Block tags (a block tagged `readiness` or `requirement` is a requirement check). */
  blockTags?: string[]
  /** Result of the failed step (checked for `requirementUnclear: true`). */
  result?: Record<string, unknown>
  /** Axon (native) runtime = built-in step; anything else is an AI agent. */
  runtime?: string
  rejectedAtGate?: boolean
}

const REQUIREMENT_TAGS = new Set(['readiness', 'requirement', 'requirements'])

const PLATFORM_PATTERN = /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|network|fetch failed|timed out connecting|could not resolve host|unable to access|remote end hung up|git (push|fetch|clone|pull|worktree|checkout)\b|HTTP (429|5\d\d)|\b(502|503|504)\b|rate limit)/i

/** True for errors worth an automatic retry: transient git/network/HTTP trouble. */
export function isPlatformErrorMessage(message: string | undefined, errorCode?: string): boolean {
  if (errorCode && /^(NETWORK|GIT|HTTP|PLATFORM|ETIMEDOUT|ECONN)/i.test(errorCode)) return true
  return !!message && PLATFORM_PATTERN.test(message)
}

export function classifyFailure(i: FailureInput): FailureCategory {
  if (i.rejectedAtGate) return 'Agent'
  if (i.result?.requirementUnclear === true) return 'Requirement'
  if ((i.blockTags ?? []).some((t) => REQUIREMENT_TAGS.has(t.toLowerCase()))) return 'Requirement'
  if (i.thrown) return 'Platform'
  if (i.runtime === 'Axon' && isPlatformErrorMessage(i.message, i.errorCode)) return 'Platform'
  if (i.runtime !== 'Axon' && i.errorCode && /^(NETWORK|PLATFORM)/i.test(i.errorCode)) return 'Platform'
  return i.runtime === 'Axon' ? 'Platform' : 'Agent'
}

/** Platform failures retry automatically (max 2); Agent and Requirement failures never do. */
export const PLATFORM_RETRY_LIMIT = 2
